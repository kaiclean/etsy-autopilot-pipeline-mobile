import { reserveImage } from "@/lib/image-quota";
import { themeStyles } from "@/lib/themes";
import { and, asc, count, desc, eq, gte, sql } from "drizzle-orm";
import { getImageProvider } from "@/adapters/image";
import { getLLMProvider } from "@/adapters/llm";
import type { GeneratedImage } from "@/adapters/image/types";
import { costs, designBriefs, designs, keywords, listings } from "@/db/schema";
import { isPlaceholderUrl } from "@/lib/art-quality";
import { config } from "@/lib/config";
import { assessArtwork } from "@/lib/design-quality";
import { PRINT_TARGETS, getPrintTarget, type PrintTargetKey } from "@/lib/print-targets";
import { productKeyword } from "@/lib/product-title";
import { isPodPreset } from "@/lib/fees";
import { keywordHasUndeliverablePromise } from "@/lib/delivery";
import { persistableImageUrl } from "@/lib/compact-image-url";
import { loadArtworkBytes } from "@/lib/artwork-source";
import { differenceHash, isNearDuplicate, type DesignHash } from "@/lib/design-similarity";
import { emit } from "@/lib/events";
import { isNichePaused, NICHES } from "@/lib/niches";
import { isProviderCreditsError, yieldStatus } from "@/lib/provider-errors";
import { getSetting } from "@/lib/settings";
import { digitalPreviewUrl } from "@/lib/png";
import { preparePrintFile, type PreparedArt } from "./artwork";
import { stageSucceededToday } from "./chain-day";
import { ensureDesignBrief } from "./design-brief";
import { upscaleArtwork, type UpscaledArtwork } from "./upscale";
import { stageResult, type StageFn } from "./types";

export const PRINT_RENDER = { width: 1024, height: 1280 } as const;

export async function aiSpend(db: Parameters<StageFn>[0]["db"], since: Date) {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${costs.amountChf}), 0)::float` })
    .from(costs)
    .where(and(gte(costs.createdAt, since), sql`${costs.kind} in ('ai_image','ai_text')`));
  return Number(row?.total ?? 0);
}

const NICHE_PROMPTS: Record<string, string> = {
  alpine:
    "Swiss and alpine-inspired wall art with a clear focal subject, painterly but crisp and print-ready",
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

/** Rendering styles rotated per run so a day's designs do not share one look. */
export const STYLES = [
  "vintage travel-poster lithograph",
  "loose watercolor",
  "bold linocut print",
  "mid-century screenprint",
  "fine botanical engraving",
  "gouache illustration",
  "art deco poster",
  "risograph print with grain",
];

function words(text: string) {
  return new Set(text.toLowerCase().split(/[^a-z]+/).filter((word) => word.length > 3));
}

/**
 * Picks an unused style + motif + palette. The keyword stays the main subject (see `buildPrompt`);
 * the motif is only chosen from niche subjects that share no words with recent concepts in this run,
 * and motifs the keyword itself contradicts are skipped (a "christmas cabin" keyword gets no mountain lake).
 */
export function chooseConcept(niche: string, recent: string[], phrase = "") {
  const used = new Set(recent.map((concept) => concept.toLowerCase()));
  const usedStyles = new Set(STYLES.filter((style) => recent.some((concept) => concept.toLowerCase().includes(style))));
  const usedSubjects = new Set((SUBJECTS[niche] ?? SUBJECTS.alpine!).filter((subject) => recent.some((concept) => concept.toLowerCase().includes(subject))));
  const keywordWords = words(phrase);
  const subjects = (SUBJECTS[niche] ?? SUBJECTS.alpine!);
  const relevant = keywordWords.size
    ? [...subjects].sort((a, b) => Number([...words(b)].some((w) => keywordWords.has(w))) - Number([...words(a)].some((w) => keywordWords.has(w))))
    : subjects;
  const candidates: string[] = [];
  for (const subject of relevant) {
    for (const palette of PALETTES) {
      for (const style of STYLES) candidates.push(`${style}: ${subject} in ${palette}`);
    }
  }
  const fresh = candidates.find((concept) => {
    const style = STYLES.find((item) => concept.startsWith(item))!;
    const subject = subjects.find((item) => concept.includes(item))!;
    return !used.has(concept) && !usedStyles.has(style) && !usedSubjects.has(subject);
  });
  return fresh ?? candidates.find((concept) => !used.has(concept)) ?? null;
}

export function buildPrompt(phrase: string, style: string, niche?: string, concept?: string) {
  const look = ((niche && NICHE_PROMPTS[niche]) || style)
    .replace(/\bno (?:text|lettering|frames?|interface chrome)\b/gi, "clean pictorial detail");
  const subject = productKeyword(phrase) || "original art";
  const [renderStyle, motif] = concept?.includes(": ") ? concept.split(": ", 2) : [null, concept];
  return `Main subject: ${subject}. The artwork must clearly depict ${subject}; do not substitute a generic mountain landscape unless the subject asks for one. ${renderStyle ? `Style: ${renderStyle}. ` : ""}${look}. ${motif ? `Secondary motif and palette: ${motif}. ` : ""}Original unframed full-bleed artwork with clean edges, a detailed central subject, high contrast, crisp detail and rich color variation. All marks are pictorial rather than typography; the corners contain clean artwork continuous with the composition. Opaque background with meaningful visual detail throughout. Avoid rendering defects: no melted or warped objects, no unintended fire or smoke, no distorted geometry.`;
}

/** Selected keywords from today's research first, then interleaved across niches so one niche cannot fill the run. */
export function orderDesignQueue<T extends { niche: string; updatedAt: Date | null; score: number; designFailures: number }>(rows: T[], dayStart: Date, limit: number) {
  const today = (row: T) => (row.updatedAt ? row.updatedAt >= dayStart : false);
  const sorted = [...rows].sort((a, b) => Number(today(b)) - Number(today(a)) || a.designFailures - b.designFailures || b.score - a.score);
  const byNiche = new Map<string, T[]>();
  for (const row of sorted) byNiche.set(row.niche, [...(byNiche.get(row.niche) ?? []), row]);
  const out: T[] = [];
  const pick = (todayOnly: boolean) => {
    let progressed = true;
    while (out.length < limit && progressed) {
      progressed = false;
      for (const list of byNiche.values()) {
        const index = list.findIndex((row) => !todayOnly || today(row));
        if (index < 0 || out.length >= limit) continue;
        out.push(list.splice(index, 1)[0]!);
        progressed = true;
      }
    }
  };
  pick(true);
  pick(false);
  return out;
}

export const runDesign: StageFn = async (ctx) => {
  const { db, log } = ctx;
  const automation = await getSetting(db, "automation");
  const provider = getImageProvider({ demo: ctx.demo, log });
  log(`Image provider: ${provider.name}${provider.name === "mock" ? " (DEMO placeholder — not queued for approval)" : ""} (est. CHF ${provider.estimatedCostChf.toFixed(2)}/image)`);

  // Seeded demo keywords are never sent to a paid image provider for a live shop.
  const liveOnly = ctx.demo ? undefined : eq(keywords.isDemo, false);
  const queueDayStart = new Date(ctx.now);
  queueDayStart.setUTCHours(0, 0, 0, 0);
  let queue = orderDesignQueue(await db
    .select()
    .from(keywords)
    .where(and(eq(keywords.shopId, ctx.shopId), eq(keywords.status, "selected"), liveOnly))
    .orderBy(asc(keywords.designFailures), desc(keywords.score))
    .limit(200), queueDayStart, automation.designsPerRun);
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
  let estimatedNeuronsToday = 0;
  if (provider.estimatedNeuronsPerImage) {
    const [usage] = await db.select({ count: count() }).from(costs).where(and(
      gte(costs.createdAt, dayStart),
      eq(costs.kind, "ai_image"),
      sql`${costs.note} like 'Workers AI neurons:%'`,
    ));
    estimatedNeuronsToday = Number(usage?.count ?? 0) * provider.estimatedNeuronsPerImage;
  }

  let made = 0;
  let briefed = 0;
  let failures = 0;
  let creditsStopped = false;
  let budgetStopped = false;
  const recentBriefs = await db.select({ niche: designBriefs.niche, concept: designBriefs.concept }).from(designBriefs)
    .where(and(eq(designBriefs.shopId, ctx.shopId), ctx.demo ? undefined : eq(designBriefs.isDemo, false)))
    .orderBy(desc(designBriefs.id)).limit(30);
  const runConcepts: string[] = [];
  const runHashes: DesignHash[] = [];
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
    if (keywordHasUndeliverablePromise(kw.phrase)) {
      await db.update(keywords).set({ status: "rejected", updatedAt: ctx.now }).where(eq(keywords.id, kw.id));
      log(`Skipped “${kw.phrase}”: the requested file claim is not deliverable`, "warn");
      continue;
    }
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
    ], kw.phrase);
    if (!previous[0] && !concept) {
      await db.update(keywords).set({ status: "new", updatedAt: ctx.now }).where(eq(keywords.id, kw.id));
      log(`Deferred duplicate brief for “${kw.phrase}”: no unused concept/palette in this run`, "warn");
      continue;
    }
    const themeStyle = kw.themeId ? (await themeStyles(db, [kw.themeId])).get(kw.themeId) : undefined;
    const prompt = previous[0]?.prompt ?? (themeStyle
      ? buildPrompt(kw.phrase, themeStyle, undefined, concept!)
      : buildPrompt(kw.phrase, niche.style, kw.niche, concept!));
    const brief = await ensureDesignBrief(ctx, kw, prompt, concept ?? previous[0]?.concept ?? undefined);
    const targetKey: PrintTargetKey = brief.brief?.productType === "pod"
      ? (isPodPreset(brief.brief.podPreset ?? "") ? brief.brief.podPreset! as PrintTargetKey : "posterA3")
      : "digitalLarge";
    const target = targetKey === "digitalLarge" ? PRINT_TARGETS.digitalLarge : await getPrintTarget(targetKey);
    const generationSize = Math.min(1920 / target.targetW, 1920 / target.targetH);
    // Print (POD) renders natively at 4:5 1024×1280 so one 4× Real-ESRGAN pass reaches 4096×5120 (≥ tee 4016×5057, A3).
    const generationWidth = targetKey !== "digitalLarge" ? PRINT_RENDER.width : Math.max(256, Math.floor(target.targetW * generationSize));
    const generationHeight = targetKey !== "digitalLarge" ? PRINT_RENDER.height : Math.max(256, Math.floor(target.targetH * generationSize));
    if (brief.created) {
      runConcepts.push(concept!);
      briefed++;
      log(`Design brief for “${kw.phrase}” (${brief.brief?.productType ?? "listing"}${brief.brief?.podPreset ? `/${brief.brief.podPreset}` : ""})`);
    }
    try {
      type Candidate = { img: GeneratedImage; prepared: PreparedArt; upscale: UpscaledArtwork | null; score: number | null; reasons: string[]; review?: boolean };
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
        if (provider.estimatedNeuronsPerImage && estimatedNeuronsToday + provider.estimatedNeuronsPerImage > 10_000) {
          log("Cloudflare Workers AI estimated daily neuron budget reached; stopping before another image request.", "warn");
          budgetStopped = true;
          break;
        }
        if (provider.estimatedNeuronsPerImage) {
          estimatedNeuronsToday += provider.estimatedNeuronsPerImage;
          await db.insert(costs).values({
            shopId: ctx.shopId,
            kind: "ai_image",
            amountChf: 0,
            note: `Workers AI neurons: ${provider.estimatedNeuronsPerImage}; ${kw.phrase}`,
            isDemo: ctx.demo,
          });
          log(`Cloudflare Workers AI estimate: ${provider.estimatedNeuronsPerImage} neurons (${estimatedNeuronsToday}/10,000 today)`);
        }
        const slot = await reserveImage(db, { provider: provider.name });
        if (!slot.ok) {
          log(`${slot.reason}; stopping before another image request.`, "warn");
          budgetStopped = true;
          break;
        }
        const img = await provider.generate({
          prompt,
          niche: kw.niche,
          seed: Math.floor(ctx.random() * 1e9) + attempt,
          aspectRatio: targetKey === "mug" || kw.niche === "stream" ? "16:9" : "2:3",
          width: generationWidth,
          height: generationHeight,
          label: kw.phrase,
          print: brief.brief?.productType === "pod",
        });
        spentToday += img.costChf;
        spentMonth += img.costChf;
        if (img.costChf > 0) await db.insert(costs).values({
          shopId: ctx.shopId, kind: "ai_image", amountChf: img.costChf,
          note: `${img.provider}: ${kw.phrase} (attempt ${attempt + 1})`, isDemo: ctx.demo,
        });
        let upscaled: UpscaledArtwork | null = null;
        // Print (POD) files are Real-ESRGAN only. In pull mode the box worker does it; the item stays held meanwhile.
        const podPrint = targetKey !== "digitalLarge";
        if (!isPlaceholderUrl(img.url) && !(podPrint && config.upscale.pull)) {
          upscaled = await upscaleArtwork(
            img.url,
            target,
            {
              ...(targetKey === "digitalLarge" ? { fallbackTarget: PRINT_TARGETS.digital } : {}),
              posterFinish: config.upscale.posterFinish && (targetKey === "posterA3" || targetKey === "canvas"),
            },
          );
          // No Lanczos fallback for print: keep the clean source and stay held until Real-ESRGAN runs.
          if (podPrint && upscaled.upscaleMethod === "lanczos") upscaled = null;
        }
        const outputUrl = upscaled?.url ?? img.url;
        const prepared = await preparePrintFile(outputUrl);
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
          rejected = { img, prepared, upscale: upscaled, score: null, reasons: [reviewReason!], review: true };
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
          : assessArtwork(assessment, prepared.width, prepared.height, false, ctx.demo ? null : prepared.variance);
        rejected = { img, prepared, upscale: upscaled, score: assessment.score, reasons: check.reasons };
        if (check.pass && !isPlaceholderUrl(prepared.url)) {
          const hash = await loadArtworkBytes(prepared.url).then((bytes) => bytes ? differenceHash(bytes) : null).catch(() => null);
          if (hash != null && isNearDuplicate(hash, runHashes)) {
            rejected = { ...rejected, reasons: ["Near-duplicate of another design in this run."] };
            log(`Design “${kw.phrase}” attempt ${attempt + 1}/3 rejected: near-duplicate of another design in this run`, "warn");
            continue;
          }
          if (hash != null) runHashes.push(hash);
        }
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
      const { img, prepared, upscale } = result;
      if (!accepted) {
        const imageUrl = await persistableImageUrl(prepared.url).catch(() => `/api/placeholder/${kw.id}?niche=${kw.niche}`);
        await db.insert(designs).values({
          shopId: ctx.shopId, keywordId: kw.id, niche: kw.niche, prompt, provider: img.provider,
          imageUrl, provenance: img.provenance ?? null, sourceImageUrl: img.url,
          sourcePx: upscale?.sourcePx ?? null, outputPx: upscale?.outputPx ?? null, upscaleMethod: upscale?.upscaleMethod ?? null,
          printTarget: target,
          imageWidth: prepared.width, imageHeight: prepared.height,
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
          sourceImageUrl: img.url,
          provider: img.provider,
          provenance: img.provenance ?? null,
          sourcePx: upscale?.sourcePx ?? null,
          outputPx: upscale?.outputPx ?? null,
          upscaleMethod: upscale?.upscaleMethod ?? null,
          printTarget: target,
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
        provenance: img.provenance ?? null,
        imageUrl,
        sourceImageUrl: img.url,
        sourcePx: upscale?.sourcePx ?? null,
        outputPx: upscale?.outputPx ?? null,
        upscaleMethod: upscale?.upscaleMethod ?? null,
        printTarget: target,
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
