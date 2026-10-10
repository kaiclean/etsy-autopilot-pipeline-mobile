import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import { getImageProvider } from "@/adapters/image";
import { getLLMProvider } from "@/adapters/llm";
import type { GeneratedImage } from "@/adapters/image/types";
import { costs, designBriefs, designs, keywords, listings } from "@/db/schema";
import { isPlaceholderUrl, MIN_COLOR_STDDEV } from "@/lib/art-quality";
import { assessArtwork } from "@/lib/design-quality";
import { productKeyword } from "@/lib/product-title";
import { persistableImageUrl } from "@/lib/compact-image-url";
import { emit } from "@/lib/events";
import { isNichePaused, NICHES } from "@/lib/niches";
import { isProviderCreditsError, yieldStatus } from "@/lib/provider-errors";
import { getSetting } from "@/lib/settings";
import { digitalPreviewUrl } from "@/lib/png";
import { preparePrintFile, type PreparedArt } from "./artwork";
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
    "Alpine wall art with a clear mountain or landscape focal subject, painterly but crisp and print-ready",
  gothic: "Dark botanical art with a clearly readable focal subject",
  christmas:
    "Cozy winter illustration with a clearly readable seasonal focal subject and hand-drawn texture",
  birthday:
    "Playful birthday illustration with a clear celebration still life, opaque background and paper texture",
  stream:
    "Neon scene with crisp shapes, high contrast and an opaque background without interface chrome",
};

/** After this many provider failures, the keyword returns to the backlog so research can pick another. */
export const DESIGN_FAILURE_COOLDOWN = 2;

const SUBJECTS: Record<string, string[]> = {
  gothic: ["ink botanical", "moonlit herbarium", "wildflower silhouette", "thorn and moth study", "twilight rose garden", "fern and raven", "orchid still life", "woodland fungi"],
  alpine: ["layered mountain lake", "snow ridge at sunrise", "pine valley", "alpine meadow", "glacier overlook", "mountain stream", "summit clouds", "highland forest"],
  christmas: ["winter cabin", "pine still life", "snowy village", "candlelit forest", "winter wreath", "frosted windows", "holiday lantern", "woodland firs"],
  birthday: ["confetti still life", "balloon garden", "cake illustration", "party ribbons", "flower celebration", "festive streamers", "paper garlands", "cupcake tableau"],
  stream: ["neon city", "cosmic shapes", "electric landscape", "abstract light", "luminous horizon", "laser garden", "radiant skyline", "prismatic waves"],
};
const PALETTES = ["ivory and charcoal", "teal and copper", "ochre and midnight", "indigo and silver", "jade and cream", "apricot and blue", "coral and graphite", "gold and slate"];

export function chooseConcept(niche: string, recent: string[]) {
  const used = new Set(recent.map((concept) => concept.toLowerCase()));
  for (const subject of SUBJECTS[niche] ?? SUBJECTS.alpine!) {
    for (const palette of PALETTES) {
      const concept = `${subject} in ${palette}`;
      if (!used.has(concept)) return concept;
    }
  }
  return null;
}

export function buildPrompt(phrase: string, style: string, niche?: string, concept?: string) {
  const look = ((niche && NICHE_PROMPTS[niche]) || style)
    .replace(/\bno (?:text|lettering|frames?|interface chrome)\b/gi, "clean pictorial detail");
  return `${look}. Subject: ${productKeyword(phrase) || "original art"}. ${concept ? `Concept: ${concept}. ` : ""}Original unframed full-bleed artwork with clean edges, a detailed central subject, high contrast, crisp detail and rich color variation. All marks are pictorial rather than typography; the corners contain clean artwork continuous with the composition. Opaque background with meaningful visual detail throughout.`;
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
  const vision = (() => { try { return getLLMProvider({ demo: ctx.demo }); } catch { return null; } })();

  const dayStart = new Date(ctx.now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const monthStart = new Date(Date.UTC(ctx.now.getUTCFullYear(), ctx.now.getUTCMonth(), 1));
  let spentToday = await aiSpend(db, dayStart);
  let spentMonth = await aiSpend(db, monthStart);

  let made = 0;
  let briefed = 0;
  let failures = 0;
  let creditsStopped = false;
  let budgetStopped = false;
  const recentBriefs = await db.select({ niche: designBriefs.niche, concept: designBriefs.concept }).from(designBriefs)
    .where(and(eq(designBriefs.shopId, ctx.shopId), ctx.demo ? undefined : eq(designBriefs.isDemo, false)))
    .orderBy(desc(designBriefs.id)).limit(30);
  const runConcepts: string[] = [];
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
    if (isNichePaused(kw.niche)) {
      await db.update(keywords).set({ status: "rejected", updatedAt: ctx.now }).where(eq(keywords.id, kw.id));
      log(`Skipped “${kw.phrase}”: ${NICHES[kw.niche].pausedReason}`, "warn");
      continue;
    }
    const niche = NICHES[kw.niche];
    const previous = await db.select({ prompt: designBriefs.prompt, concept: designBriefs.concept }).from(designBriefs).where(eq(designBriefs.keywordId, kw.id)).limit(1);
    const concept = previous[0] ? null : chooseConcept(kw.niche, [
      ...recentBriefs.filter((row) => row.niche === kw.niche).slice(0, 30).map((row) => row.concept).filter((value): value is string => Boolean(value)),
      ...runConcepts,
    ]);
    if (!previous[0] && !concept) {
      await db.update(keywords).set({ status: "new", updatedAt: ctx.now }).where(eq(keywords.id, kw.id));
      log(`Deferred duplicate brief for “${kw.phrase}”: no unused concept/palette in this run`, "warn");
      continue;
    }
    const prompt = previous[0]?.prompt ?? buildPrompt(kw.phrase, niche.style, kw.niche, concept!);
    const brief = await ensureDesignBrief(ctx, kw, prompt, concept ?? previous[0]?.concept ?? undefined);
    if (brief.created) {
      runConcepts.push(concept!);
      briefed++;
      log(`Design brief for “${kw.phrase}” (${brief.brief?.productType ?? "listing"}${brief.brief?.podPreset ? `/${brief.brief.podPreset}` : ""})`);
    }
    try {
      type Candidate = { img: GeneratedImage; prepared: PreparedArt; score: number | null; reasons: string[]; review?: boolean };
      let accepted: Candidate | null = null;
      let rejected: Candidate | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        // Reserve for the vision call as well as image generation before each attempt.
        if (spentToday + provider.estimatedCostChf + 0.02 > automation.dailyAiCapChf ||
            spentMonth + provider.estimatedCostChf + 0.02 > automation.monthlyAiBudgetChf) {
          log(`Daily AI cap reached or monthly AI budget reached before attempt ${attempt + 1} for “${kw.phrase}”`, "warn");
          budgetStopped = true;
          break;
        }
        const img = await provider.generate({
          prompt,
          niche: kw.niche,
          seed: Math.floor(ctx.random() * 1e9) + attempt,
          aspectRatio: kw.niche === "stream" ? "16:9" : "2:3",
          label: kw.phrase,
          print: brief.brief?.productType === "pod" && brief.brief.podPreset === "posterA3",
        });
        spentToday += img.costChf;
        spentMonth += img.costChf;
        if (img.costChf > 0) await db.insert(costs).values({
          shopId: ctx.shopId, kind: "ai_image", amountChf: img.costChf,
          note: `${img.provider}: ${kw.phrase} (attempt ${attempt + 1})`, isDemo: ctx.demo,
        });
        const print = brief.brief?.productType === "pod" && brief.brief.podPreset === "posterA3";
        const prepared = await preparePrintFile(img.url);
        let reviewReason: string | null = null;
        const assessment = ctx.demo && isPlaceholderUrl(prepared.url)
          ? { score: 0, reasons: [], text: false, empty: false, frameOnly: false, artifacts: false }
          : !ctx.demo && (isPlaceholderUrl(prepared.url) || img.provider === "mock")
            ? { score: 0, reasons: ["Placeholder art."], text: false, empty: false, frameOnly: false, artifacts: false }
            : await (async () => {
              try {
                if (!vision?.assessImage) throw new Error("Vision model is unavailable");
                const preview = prepared.visionPreview ?? (prepared.url.startsWith("https://") ? prepared.url : null);
                if (!preview) throw new Error("Vision preview is unavailable");
                return await vision.assessImage(preview);
              } catch {
                reviewReason = "Vision assessment unavailable; human image review required.";
                return null;
              }
            })();
        if (!assessment) {
          rejected = { img, prepared, score: null, reasons: [reviewReason!], review: true };
          log(`Design “${kw.phrase}” needs review: ${reviewReason}`, "warn");
          break;
        }
        const visionCost = assessment.costChf ?? 0;
        if (visionCost > 0) {
          spentToday += visionCost;
          spentMonth += visionCost;
          await db.insert(costs).values({
            shopId: ctx.shopId, kind: "ai_text", amountChf: visionCost,
            note: `${vision?.name ?? "vision"}: design assessment`, isDemo: ctx.demo,
          });
        }
        const check = ctx.demo && isPlaceholderUrl(prepared.url)
          ? { pass: true, reasons: [] }
          : assessArtwork(assessment, prepared.width, prepared.height, print && img.provider === "runpod");
        if (prepared.variance != null && prepared.variance < MIN_COLOR_STDDEV && !ctx.demo) check.reasons.push("Flat artwork.");
        check.pass = check.reasons.length === 0;
        rejected = { img, prepared, score: assessment.score, reasons: check.reasons };
        if (check.pass) {
          accepted = rejected;
          break;
        }
        log(`Design “${kw.phrase}” attempt ${attempt + 1}/3 rejected: ${check.reasons.join("; ")}`, "warn");
      }
      if (!accepted && !rejected) break;
      if (!accepted && budgetStopped) {
        log(`Deferred “${kw.phrase}” until the AI budget resets; quality retries are incomplete`, "warn");
        break;
      }
      const result = accepted ?? rejected!;
      const { img, prepared } = result;
      if (!accepted) {
        const imageUrl = await persistableImageUrl(prepared.url).catch(() => `/api/placeholder/${kw.id}?niche=${kw.niche}`);
        await db.insert(designs).values({
          shopId: ctx.shopId, keywordId: kw.id, niche: kw.niche, prompt, provider: img.provider,
          imageUrl, imageWidth: prepared.width, imageHeight: prepared.height,
          colorVariance: prepared.variance, costChf: img.costChf,
          qualityScore: result.score, qualityReasons: result.reasons, status: result.review ? "needs_review" : "rejected", isDemo: ctx.demo,
        });
        if (!result.review) failures++;
        await db.update(keywords).set({ status: result.review ? "used" : "rejected", updatedAt: ctx.now }).where(eq(keywords.id, kw.id));
        log(`${result.review ? "Review required" : "Rejected design"} for “${kw.phrase}”: ${result.reasons.join("; ")}`, "warn");
        if (budgetStopped) break;
        continue;
      }
      if (!ctx.demo && (isPlaceholderUrl(prepared.url) || img.provider === "mock")) {
        failures++;
        await noteFailure(kw);
        log(`Refusing placeholder art for “${kw.phrase}”`, "error");
        continue;
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
          qualityScore: result.score,
          qualityReasons: result.reasons,
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
        qualityScore: result.score,
        qualityReasons: result.reasons,
        costChf: img.costChf,
        isDemo: ctx.demo,
      });
      await db.update(keywords).set({ status: "used", updatedAt: ctx.now }).where(eq(keywords.id, kw.id));
      await db.update(designBriefs).set({ status: "designed" }).where(eq(designBriefs.keywordId, kw.id));
      made++;
      log(`Generated design for “${kw.phrase}”`);
      if (budgetStopped) break;
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
