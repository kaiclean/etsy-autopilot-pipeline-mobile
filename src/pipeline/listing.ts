import { and, eq } from "drizzle-orm";
import { getLLMProvider, type LLMProvider } from "@/adapters/llm";
import { costs, designs, keywords, listings } from "@/db/schema";
import type { Niche, ProductType } from "@/db/schema";
import { alignDeliveryCopy, leadPhrase } from "@/lib/delivery";
import { withDisclosures } from "@/lib/disclosures";
import { emit } from "@/lib/events";
import { calculateFees, podCostChf, POD_PRESETS, resolveTargetMargin, suggestPrice, type PodPreset } from "@/lib/fees";
import { quoteLadder, type LadderRung } from "@/lib/pricing-ladder";
import { isPlaceholderUrl } from "@/lib/art-quality";
import { repairTrivialCopy, validateListing } from "@/lib/listing-validator";
import { evaluateQualityGate } from "@/lib/quality-gate";
import { containsInlineImage, persistableImageUrl } from "@/lib/compact-image-url";
import { buildFileManifest } from "@/lib/file-manifest";
import { isNichePaused, NICHES } from "@/lib/niches";
import { yieldStatus } from "@/lib/provider-errors";
import { getSetting } from "@/lib/settings";
import { listingImageForProduct } from "./mockup";
import { buildProductTitle, productKeyword } from "@/lib/product-title";
import { MIN_DESIGN_SCORE } from "@/lib/design-quality";
import { stageResult, type StageContext, type StageFn } from "./types";

export function pickProduct(niche: Niche, r: number): { type: ProductType; pod?: PodPreset } {
  const mix = NICHES[niche].productMix;
  let acc = 0;
  for (const m of mix) {
    acc += m.weight;
    if (r < acc) return { type: m.type, pod: m.pod };
  }
  return { type: mix[0].type, pod: mix[0].pod };
}

/** When the keyword names a mug, poster, tee, or sweatshirt, the brief uses that variant. */
export function productForPhrase(niche: Niche, phrase: string, random: number): { type: ProductType; pod?: PodPreset } {
  const wantsSweat = /\bsweatshirts?\b/i.test(phrase);
  const wantsMug = /\bmugs?\b/i.test(phrase);
  const wantsPoster = /\bposters?\b/i.test(phrase);
  const wantsShirt = !wantsSweat && /\b(?:t-?shirts?|tees?)\b/i.test(phrase);
  const preferred = wantsMug ? "mug" : wantsPoster ? "posterA3" : wantsSweat ? "sweatshirt" : wantsShirt ? "tshirt" : null;
  if (preferred) {
    const match = NICHES[niche].productMix.find((item) => item.pod === preferred);
    if (match) return { type: match.type, pod: match.pod };
  }
  return pickProduct(niche, random);
}

export async function draftListing(opts: {
  niche: Niche;
  keyword: string;
  product: { type: ProductType; pod?: PodPreset };
  seed: number;
  /** Ignored. Pricing uses podTargetMarginPct / digitalTargetMarginPct. */
  targetMarginPct?: number;
  podTargetMarginPct?: number;
  digitalTargetMarginPct?: number;
  assumeOffsiteAds: boolean;
  /** Override the preset's CHF competitor anchor. Digital listings ignore this. */
  competitorChf?: number;
  /** Ladder price. When set, fees include the 15% offsite-ads line so the stored net matches that price. */
  priceChf?: number;
  llm?: LLMProvider;
  /** Demo shops may use the template writer. Live shops require a real LLM provider. */
  demo?: boolean;
  artDirection?: string;
}) {
  const llm = opts.llm ?? getLLMProvider({ demo: opts.demo });
  const keyword = leadPhrase(productKeyword(opts.keyword) || opts.keyword, opts.niche, opts.product.type);
  const copy = await llm.writeListing({
    keyword,
    niche: opts.niche,
    productType: opts.product.type,
    podPreset: opts.product.pod,
    seed: opts.seed,
    artDirection: opts.artDirection,
  });
  const product = opts.product.type === "digital" ? "digital" : opts.product.pod ?? "posterA3";
  const title = buildProductTitle(opts.keyword, copy.title, product);
  const styleClaims = /\b(?:engraving|etched|watercolor|oil painting|linocut|photograph|vintage)\b/i;
  const tags = copy.tags.filter((tag) => !styleClaims.test(tag) || opts.artDirection?.toLowerCase().includes(tag.toLowerCase()));
  const preset = opts.product.pod ?? "posterA3";
  const pod = opts.product.type === "pod" ? podCostChf(preset) : 0;
  const band = NICHES[opts.niche].priceBand[opts.product.type];
  const targetMarginPct =
    opts.product.type === "pod" ? resolveTargetMargin("pod", opts.podTargetMarginPct) : resolveTargetMargin("digital", opts.digitalTargetMarginPct);
  const priceChf =
    opts.priceChf ??
    suggestPrice({
      targetMarginPct,
      podCostChf: pod,
      offsiteAds: opts.assumeOffsiteAds,
      minChf: band[0] || undefined,
      maxChf: band[1] || undefined,
      competitorChf: opts.product.type === "pod" ? (opts.competitorChf ?? POD_PRESETS[preset].marketAnchorChf) : undefined,
      productType: opts.product.type,
    });
  const repaired = repairTrivialCopy(
    {
      title,
      tags,
      description: withDisclosures(alignDeliveryCopy(copy.body, opts.product.type), opts.product.type),
      priceChf,
      productType: opts.product.type,
    },
    { keyword, product: opts.product },
  );
  const draft = repaired.draft;
  const fees = calculateFees({ priceChf, podCostChf: pod, offsiteAds: opts.priceChf != null ? true : opts.assumeOffsiteAds });
  const { issues } = validateListing(draft);
  return { draft, fees, issues, pod, llmCost: copy.costChf, provider: copy.provider, fixes: repaired.fixes };
}

function keywordForRung(phrase: string, rung: LadderRung) {
  const stripped = phrase.replace(/\b(?:mugs?|posters?|sweatshirts?|t-?shirts?|tees?)\b/gi, " ").replace(/\s+/g, " ").trim();
  const base = stripped || phrase;
  if (rung.id === "digital-mid") return `${base} large print`;
  return base;
}

async function listRung(
  ctx: StageContext,
  design: typeof designs.$inferSelect,
  phrase: string,
  rung: LadderRung,
  artworkUrl: string,
  automation: { podTargetMarginPct?: number; digitalTargetMarginPct?: number; assumeOffsiteAds: boolean },
  llm: LLMProvider,
) {
  const { draft, fees, issues, pod, llmCost, provider, fixes } = await draftListing({
    niche: design.niche,
    keyword: keywordForRung(phrase, rung),
    product: rung.product,
    seed: design.id,
    podTargetMarginPct: automation.podTargetMarginPct,
    digitalTargetMarginPct: automation.digitalTargetMarginPct,
    assumeOffsiteAds: automation.assumeOffsiteAds,
    priceChf: rung.priceChf,
    llm,
    artDirection: design.prompt,
  });
  const image = await listingImageForProduct({
    productType: rung.product.type,
    artworkUrl,
    preset: rung.product.pod,
    niche: design.niche,
  });
  if (containsInlineImage(image.url)) throw new Error("Refusing to store an inline gallery image.");
  const deliveryUrl = rung.product.type === "digital" ? artworkUrl : null;
  const fileManifest = deliveryUrl ? await buildFileManifest(deliveryUrl, image.url) : null;
  const gate = evaluateQualityGate({
    title: draft.title,
    tags: draft.tags,
    description: draft.description,
    priceChf: draft.priceChf,
    productType: rung.product.type,
    podProvider: rung.product.type === "pod" && rung.product.pod ? `printify:${rung.product.pod}` : null,
    imageUrl: image.url,
    artworkUrl,
    printWidth: design.imageWidth,
    printHeight: design.imageHeight,
    colorVariance: design.colorVariance,
  });
  const validation = [...issues, ...gate.reasons.filter((reason) => !issues.some((item) => item.code === reason.code && item.message === reason.message))];
  await ctx.db.insert(listings).values({
    shopId: ctx.shopId,
    designId: design.id,
    keywordId: design.keywordId,
    niche: design.niche,
    productType: rung.product.type,
    podProvider: rung.product.type === "pod" && rung.product.pod ? `printify:${rung.product.pod}` : null,
    title: draft.title,
    tags: draft.tags,
    description: draft.description,
    imageUrl: image.url,
    deliveryUrl,
    fileManifest,
    priceChf: draft.priceChf,
    podCostChf: pod,
    netChf: fees.netChf,
    marginPct: fees.marginPct,
    validation,
    status: gate.pass ? "pending_approval" : "quality_failed",
    isDemo: ctx.demo,
  });
  if (llmCost > 0) {
    await ctx.db.insert(costs).values({
      shopId: ctx.shopId,
      kind: "ai_text",
      amountChf: llmCost,
      note: `${provider}: ${rung.label}`,
      isDemo: ctx.demo,
    });
  }
  return {
    fixes,
    errors: issues.filter((issue) => issue.severity === "error").map((issue) => issue.message),
    passed: gate.pass,
    hold: gate.reasons.map((reason) => reason.message).join("; "),
    title: draft.title,
    priceChf: draft.priceChf,
    netChf: fees.netChf,
    marginPct: fees.marginPct,
  };
}

export const runListing: StageFn = async (ctx) => {
  const { db, log } = ctx;
  const automation = await getSetting(db, "automation");
  const pending = await db
    .select({ design: designs, phrase: keywords.phrase })
    .from(designs)
    .leftJoin(keywords, eq(designs.keywordId, keywords.id))
    .where(and(eq(designs.shopId, ctx.shopId), eq(designs.status, "generated"), ctx.demo ? undefined : eq(designs.isDemo, false)))
    .limit(10);
  if (pending.length === 0) return "No new designs waiting for listings.";
  const llm = getLLMProvider({ demo: ctx.demo });
  log(`Listing writer: ${llm.name}${llm.name === "mock-template" ? " (DEMO template copy)" : ""}`);

  let created = 0;
  let held = 0;
  let invalid = 0;
  let rungFailures = 0;
  const notes: string[] = [];
  for (const { design, phrase } of pending) {
    if (!ctx.demo && (design.qualityScore == null || design.qualityScore < MIN_DESIGN_SCORE || design.qualityReasons.length)) {
      await db.update(designs).set({ status: "rejected", qualityReasons: [...design.qualityReasons, "No passing image quality assessment."] }).where(eq(designs.id, design.id));
      log(`Rejected unassessed design #${design.id} before Listing`, "warn");
      continue;
    }
    if (isNichePaused(design.niche)) {
      await db.update(designs).set({ status: "discarded" }).where(eq(designs.id, design.id));
      log(`Skipped design #${design.id}: ${NICHES[design.niche].pausedReason}`, "warn");
      continue;
    }
    const phraseText = phrase ?? NICHES[design.niche].seeds[0]!.phrase;
    const artworkUrl = await persistableImageUrl(design.imageUrl);
    if (isPlaceholderUrl(artworkUrl)) {
      log(`Design #${design.id} is DEMO placeholder art and will be held off the queue`, "warn");
    }
    let listed = 0;
    for (const rung of quoteLadder(design.niche)) {
      try {
        const made = await listRung(ctx, design, phraseText, rung, artworkUrl, automation, llm);
        if (made.fixes.length) log(`Auto-fixed design #${design.id} ${rung.label} before the quality gate: ${made.fixes.join("; ")}`);
        if (made.errors.length) {
          invalid++;
          const text = made.errors.join("; ");
          notes.push(`#${design.id} ${rung.label}: ${text}`);
          log(`Needs fixes for “${made.title.slice(0, 60)}”: ${text}`, "warn");
        }
        if (!made.passed) {
          held++;
          notes.push(`#${design.id} ${rung.label} quality hold: ${made.hold}`);
          log(`Quality hold for “${made.title.slice(0, 60)}”: ${made.hold}`, "warn");
        }
        created++;
        listed++;
        log(`Listed “${made.title.slice(0, 60)}…” (${rung.label}) at CHF ${made.priceChf.toFixed(2)} → net ${made.netChf.toFixed(2)} (${made.marginPct}%)`);
      } catch (e) {
        rungFailures++;
        log(`Listing failed for design #${design.id} ${rung.label}: ${(e as Error).message}`, "error");
      }
    }
    if (listed) await db.update(designs).set({ status: "listed" }).where(eq(designs.id, design.id));
  }
  const queued = created - held;
  if (queued) {
    await emit(db, {
      type: "approval.pending",
      title: `${queued} listing${queued > 1 ? "s" : ""} awaiting approval`,
      body: invalid ? notes.filter((note) => !note.includes("quality hold")).join(" | ").slice(0, 280) : "Swipe to approve or reject",
      severity: "warning",
      href: "/queue",
    }, ctx.demo);
  }
  if (held) {
    await emit(db, {
      type: "quality.failed",
      title: `${held} listing${held > 1 ? "s" : ""} held by the quality gate`,
      body: notes.filter((note) => note.includes("quality hold")).join(" | ").slice(0, 280) || "They stay off the approval queue. The dashboard lists each reason.",
      severity: "warning",
      href: "/",
    }, ctx.demo);
  }
  const detail = notes.length ? `: ${notes.join(" | ").slice(0, 420)}` : "";
  const summary = `Drafted ${queued} listings for approval${held ? `, held ${held} at the quality gate` : ""}${invalid ? ` (${invalid} need fixes)` : ""}${detail}`;
  const status = yieldStatus(created, rungFailures);
  if (status === "success") return summary;
  return stageResult(summary, status);
};
