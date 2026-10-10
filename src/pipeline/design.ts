import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import { getImageProvider } from "@/adapters/image";
import { costs, designBriefs, designs, keywords, listings } from "@/db/schema";
import { isPlaceholderUrl, MIN_COLOR_STDDEV } from "@/lib/art-quality";
import { persistableImageUrl } from "@/lib/compact-image-url";
import { emit } from "@/lib/events";
import { isNichePaused, NICHES } from "@/lib/niches";
import { isProviderCreditsError, yieldStatus } from "@/lib/provider-errors";
import { getSetting } from "@/lib/settings";
import { digitalPreviewUrl } from "@/lib/png";
import { preparePrintFile } from "./artwork";
import { stageSucceededToday } from "./chain-day";
import { ensureDesignBrief } from "./design-brief";
import { stageResult, type StageFn } from "./types";

export async function aiSpend(db: Parameters<StageFn>[0]["db"], since: Date) {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${costs.amountChf}), 0)::float` })
    .from(costs)
    .where(and(gte(costs.createdAt, since), sql`${costs.kind} in ('ai_image','ai_text')`));
  return Number(row?.total ?? 0);
}

const NICHE_PROMPTS: Record<string, string> = {
  alpine:
    "Bestselling Etsy alpine wall art: layered Swiss mountain ridges, a quiet lake, soft film grain, muted sage and stone, generous negative space, painterly but crisp, print-ready",
  gothic:
    "Bestselling Etsy dark botanical: dense gothic florals, plum, burgundy and near-black, vintage engraving texture, candlelit contrast, autumn leaves, ornate and readable at mug size",
  christmas:
    "Bestselling Etsy cozy Christmas illustration: warm candlelight, pine green and deep red, a snowy cabin, hygge still life, hand-drawn texture, gift-ready and highly detailed",
  birthday:
    "Bestselling Etsy birthday illustration: playful pastel shapes, soft paper texture, a small celebration still life, opaque background, charming and print-ready",
  stream:
    "Bestselling Etsy neon scene: saturated purple and cyan light, a solid opaque background, crisp shapes, high contrast, no frames and no interface chrome",
};

/** After this many provider failures, the keyword returns to the backlog so research can pick another. */
export const DESIGN_FAILURE_COOLDOWN = 2;

export function buildPrompt(phrase: string, style: string, niche?: string) {
  const look = (niche && NICHE_PROMPTS[niche]) || style;
  return `${look}. Subject: ${phrase}. Original composition in a bestselling Etsy style. High detail, rich color variation across the whole image, opaque background, not a flat color block, not a simple rectangle, not stripes, not transparent, no text, no lettering, no watermark, no logos, no brand names, no trademarked characters.`;
}

export const runDesign: StageFn = async (ctx) => {
  const { db, log } = ctx;
  const automation = await getSetting(db, "automation");
  const provider = getImageProvider({ demo: ctx.demo });
  log(`Image provider: ${provider.name}${provider.name === "mock" ? " (DEMO placeholder — not queued for approval)" : ""} (est. CHF ${provider.estimatedCostChf.toFixed(2)}/image)`);

  // Seeded demo keywords are never sent to a paid image provider for a live shop.
  const liveOnly = ctx.demo ? undefined : eq(keywords.isDemo, false);
  let queue = await db
    .select()
    .from(keywords)
    .where(and(eq(keywords.shopId, ctx.shopId), eq(keywords.status, "selected"), liveOnly))
    .orderBy(asc(keywords.designFailures), desc(keywords.score))
    .limit(automation.designsPerRun);
  if (queue.length === 0) {
    const chainDone = ctx.trigger === "cron" && (await stageSucceededToday(db, ctx.shopId, "daily", ctx.now));
    if (chainDone) return "No selected keywords. The daily chain already ran today, so the backlog stays put.";
    queue = await db
      .select()
      .from(keywords)
      .where(and(eq(keywords.shopId, ctx.shopId), eq(keywords.status, "new"), liveOnly))
      .orderBy(asc(keywords.designFailures), desc(keywords.score))
      .limit(automation.designsPerRun);
    if (queue.length) log("No selected keywords; falling back to top-scored backlog");
  }
  if (queue.length === 0) return "No keywords to design for. Run Research first.";

  const dayStart = new Date(ctx.now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const monthStart = new Date(Date.UTC(ctx.now.getUTCFullYear(), ctx.now.getUTCMonth(), 1));
  let spentToday = await aiSpend(db, dayStart);
  let spentMonth = await aiSpend(db, monthStart);

  let made = 0;
  let briefed = 0;
  let failures = 0;
  let creditsStopped = false;
  const noteFailure = async (kw: (typeof queue)[number]) => {
    const next = kw.designFailures + 1;
    kw.designFailures = next;
    const release = next >= DESIGN_FAILURE_COOLDOWN;
    await db
      .update(keywords)
      .set({ designFailures: next, ...(release ? { status: "new" as const } : {}), updatedAt: ctx.now })
      .where(eq(keywords.id, kw.id));
    if (release) log(`Returned “${kw.phrase}” to the backlog after ${next} provider failures`, "warn");
  };
  for (const kw of queue) {
    if (spentToday + provider.estimatedCostChf > automation.dailyAiCapChf) {
      log(`Daily AI cap reached (CHF ${spentToday.toFixed(2)} / ${automation.dailyAiCapChf}); stopping`, "warn");
      break;
    }
    if (spentMonth + provider.estimatedCostChf > automation.monthlyAiBudgetChf) {
      log(`Monthly AI budget reached (CHF ${automation.monthlyAiBudgetChf}); stopping`, "warn");
      break;
    }
    if (isNichePaused(kw.niche)) {
      await db.update(keywords).set({ status: "rejected", updatedAt: ctx.now }).where(eq(keywords.id, kw.id));
      log(`Skipped “${kw.phrase}”: ${NICHES[kw.niche].pausedReason}`, "warn");
      continue;
    }
    const niche = NICHES[kw.niche];
    const prompt = buildPrompt(kw.phrase, niche.style, kw.niche);
    const brief = await ensureDesignBrief(ctx, kw, prompt);
    if (brief.created) {
      briefed++;
      log(`Design brief for “${kw.phrase}” (${brief.brief?.productType ?? "listing"}${brief.brief?.podPreset ? `/${brief.brief.podPreset}` : ""})`);
    }
    try {
      const img = await provider.generate({
        prompt,
        niche: kw.niche,
        seed: Math.floor(ctx.random() * 1e9),
        aspectRatio: kw.niche === "stream" ? "16:9" : "2:3",
        label: kw.phrase,
      });
      const prepared = await preparePrintFile(img.url);
      if (!ctx.demo && (isPlaceholderUrl(prepared.url) || img.provider === "mock")) {
        failures++;
        await noteFailure(kw);
        log(`Refusing placeholder art for “${kw.phrase}”`, "error");
        continue;
      }
      if (prepared.variance != null && prepared.variance < MIN_COLOR_STDDEV) {
        log(`Rejected flat artwork for “${kw.phrase}” (variation ${prepared.variance.toFixed(1)})`, "error");
        if (!ctx.demo) {
          failures++;
          await noteFailure(kw);
          continue;
        }
      }
      const imageUrl = await persistableImageUrl(prepared.url);
      if (ctx.demo && isPlaceholderUrl(imageUrl)) {
        log(`DEMO placeholder for “${kw.phrase}” (${prepared.width ?? "?"}×${prepared.height ?? "?"}px). It will be held off the approval queue.`, "warn");
      }
      // Seeded demo rows never receive art paid for by a live run.
      const existingListings = await db
        .select()
        .from(listings)
        .where(and(eq(listings.keywordId, kw.id), eq(listings.shopId, ctx.shopId), ctx.demo ? undefined : eq(listings.isDemo, false)));
      const placeholders = existingListings.filter((row) => isPlaceholderUrl(row.imageUrl) || isPlaceholderUrl(row.deliveryUrl));
      if (placeholders.length && !isPlaceholderUrl(imageUrl)) {
        const refreshed = {
          imageUrl,
          provider: img.provider,
          imageWidth: prepared.width,
          imageHeight: prepared.height,
          colorVariance: prepared.variance,
          costChf: img.costChf,
        };
        for (const listing of placeholders) {
          const deliveryReplaced = Boolean(listing.deliveryUrl && isPlaceholderUrl(listing.deliveryUrl));
          await db
            .update(listings)
            .set({
              imageUrl: isPlaceholderUrl(listing.imageUrl)
                ? listing.productType === "digital"
                  ? digitalPreviewUrl(imageUrl, listing.niche)
                  : imageUrl
                : listing.imageUrl,
              deliveryUrl: deliveryReplaced ? imageUrl : listing.deliveryUrl,
              // A new delivery file needs a fresh manifest and a fresh human check.
              ...(deliveryReplaced ? { fileManifest: null, fileVerifiedAt: null, fileVerifiedBy: null } : {}),
              updatedAt: ctx.now,
            })
            .where(eq(listings.id, listing.id));
        }
        const existingDesigns = await db
          .select()
          .from(designs)
          .where(and(eq(designs.keywordId, kw.id), eq(designs.shopId, ctx.shopId), ctx.demo ? undefined : eq(designs.isDemo, false)));
        for (const design of existingDesigns) {
          if (!isPlaceholderUrl(design.imageUrl)) continue;
          await db.update(designs).set(refreshed).where(eq(designs.id, design.id));
        }
        if (img.costChf > 0) {
          await db.insert(costs).values({ shopId: ctx.shopId, kind: "ai_image", amountChf: img.costChf, note: `${img.provider}: ${kw.phrase}`, isDemo: ctx.demo });
        }
        spentToday += img.costChf;
        spentMonth += img.costChf;
        await db.update(keywords).set({ status: "used", updatedAt: ctx.now }).where(eq(keywords.id, kw.id));
        await db.update(designBriefs).set({ status: "designed" }).where(eq(designBriefs.keywordId, kw.id));
        made++;
        log(`Replaced placeholder art for “${kw.phrase}” on ${placeholders.length} listing${placeholders.length === 1 ? "" : "s"}`);
        continue;
      }
      await db.insert(designs).values({
        shopId: ctx.shopId,
        keywordId: kw.id,
        niche: kw.niche,
        prompt,
        provider: img.provider,
        imageUrl,
        imageWidth: prepared.width,
        imageHeight: prepared.height,
        colorVariance: prepared.variance,
        costChf: img.costChf,
        isDemo: ctx.demo,
      });
      if (img.costChf > 0) {
        await db.insert(costs).values({ shopId: ctx.shopId, kind: "ai_image", amountChf: img.costChf, note: `${img.provider}: ${kw.phrase}`, isDemo: ctx.demo });
      }
      spentToday += img.costChf;
      spentMonth += img.costChf;
      await db.update(keywords).set({ status: "used", updatedAt: ctx.now }).where(eq(keywords.id, kw.id));
      await db.update(designBriefs).set({ status: "designed" }).where(eq(designBriefs.keywordId, kw.id));
      made++;
      log(`Generated design for “${kw.phrase}”`);
    } catch (e) {
      const message = (e as Error).message;
      failures++;
      await noteFailure(kw);
      log(`Generation failed for “${kw.phrase}”: ${message}`, "error");
      if (isProviderCreditsError(message)) {
        creditsStopped = true;
        log("Image provider out of credits. Stopping this run so the provider is not called again.", "error");
        break;
      }
    }
  }
  if (made) {
    await emit(db, { type: "design.generated", title: `${made} new design${made > 1 ? "s" : ""} generated`, severity: "info", href: "/pipeline" }, ctx.demo);
  }
  const summary = `Briefed ${briefed}, generated ${made}/${queue.length} designs · AI spend today CHF ${spentToday.toFixed(2)}`;
  const status = yieldStatus(made, failures);
  if (status === "success") return summary;
  return stageResult(creditsStopped ? `Image provider out of credits. ${summary}` : summary, status);
};
