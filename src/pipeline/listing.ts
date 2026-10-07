import { eq } from "drizzle-orm";
import { getLLMProvider, type LLMProvider } from "@/adapters/llm";
import { costs, designBriefs, designs, keywords, listings } from "@/db/schema";
import type { Niche, ProductType } from "@/db/schema";
import { alignDeliveryCopy, leadPhrase } from "@/lib/delivery";
import { withDisclosures } from "@/lib/disclosures";
import { emit } from "@/lib/events";
import { calculateFees, podCostChf, POD_PRESETS, resolveTargetMargin, suggestPrice, type PodPreset } from "@/lib/fees";
import { sanitizeDraft, validateListing } from "@/lib/listing-validator";
import { evaluateQualityGate } from "@/lib/quality-gate";
import { containsInlineImage, persistableImageUrl } from "@/lib/compact-image-url";
import { tryBuildFileManifest } from "@/lib/file-manifest";
import { isNichePaused, NICHES } from "@/lib/niches";
import { getSetting } from "@/lib/settings";
import { listingImageForProduct } from "./mockup";
import type { StageFn } from "./types";

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

function productForDesign(
  niche: Niche,
  random: number,
  brief: { productType: ProductType; podPreset: string | null } | undefined,
) {
  const preset = brief?.podPreset && brief.podPreset in POD_PRESETS ? (brief.podPreset as PodPreset) : undefined;
  if (!brief || (brief.productType === "pod" && !preset)) return pickProduct(niche, random);
  return { type: brief.productType, pod: preset };
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
  llm?: LLMProvider;
}) {
  const llm = opts.llm ?? getLLMProvider();
  const keyword = leadPhrase(opts.keyword, opts.niche, opts.product.type);
  const copy = await llm.writeListing({
    keyword,
    niche: opts.niche,
    productType: opts.product.type,
    podPreset: opts.product.pod,
    seed: opts.seed,
  });
  const preset = opts.product.pod ?? "posterA3";
  const pod = opts.product.type === "pod" ? podCostChf(preset) : 0;
  const band = NICHES[opts.niche].priceBand[opts.product.type];
  const targetMarginPct =
    opts.product.type === "pod" ? resolveTargetMargin("pod", opts.podTargetMarginPct) : resolveTargetMargin("digital", opts.digitalTargetMarginPct);
  const priceChf = suggestPrice({
    targetMarginPct,
    podCostChf: pod,
    offsiteAds: opts.assumeOffsiteAds,
    minChf: band[0] || undefined,
    maxChf: band[1] || undefined,
    competitorChf: opts.product.type === "pod" ? (opts.competitorChf ?? POD_PRESETS[preset].marketAnchorChf) : undefined,
    productType: opts.product.type,
  });
  const draft = sanitizeDraft({
    title: copy.title,
    tags: copy.tags,
    description: withDisclosures(alignDeliveryCopy(copy.body, opts.product.type), opts.product.type),
    priceChf,
    productType: opts.product.type,
  });
  const fees = calculateFees({ priceChf, podCostChf: pod, offsiteAds: opts.assumeOffsiteAds });
  const { issues } = validateListing(draft);
  return { draft, fees, issues, pod, llmCost: copy.costChf, provider: copy.provider };
}

export const runListing: StageFn = async (ctx) => {
  const { db, log } = ctx;
  const automation = await getSetting(db, "automation");
  const pending = await db
    .select({ design: designs, phrase: keywords.phrase })
    .from(designs)
    .leftJoin(keywords, eq(designs.keywordId, keywords.id))
    .where(eq(designs.status, "generated"))
    .limit(10);
  if (pending.length === 0) return "No new designs waiting for listings.";

  let created = 0;
  let held = 0;
  let invalid = 0;
  for (const { design, phrase } of pending) {
    if (isNichePaused(design.niche)) {
      await db.update(designs).set({ status: "discarded" }).where(eq(designs.id, design.id));
      log(`Skipped design #${design.id}: ${NICHES[design.niche].pausedReason}`, "warn");
      continue;
    }
    const [brief] = design.keywordId
      ? await db.select().from(designBriefs).where(eq(designBriefs.keywordId, design.keywordId)).limit(1)
      : [];
    const product = productForDesign(design.niche, ctx.random(), brief);
    try {
      const { draft, fees, issues, pod, llmCost, provider } = await draftListing({
        niche: design.niche,
        keyword: phrase ?? NICHES[design.niche].seeds[0].phrase,
        product,
        seed: design.id,
        podTargetMarginPct: automation.podTargetMarginPct,
        digitalTargetMarginPct: automation.digitalTargetMarginPct,
        assumeOffsiteAds: automation.assumeOffsiteAds,
      });
      const artworkUrl = await persistableImageUrl(design.imageUrl);
      const image = await listingImageForProduct({
        productType: product.type,
        artworkUrl,
        preset: product.pod,
        niche: design.niche,
      });
      if (containsInlineImage(image.url)) throw new Error("Refusing to store an inline gallery image.");
      const deliveryUrl = product.type === "digital" ? artworkUrl : null;
      const fileManifest = deliveryUrl ? tryBuildFileManifest(design.imageUrl, image.url) : null;
      const gate = evaluateQualityGate({
        title: draft.title,
        tags: draft.tags,
        description: draft.description,
        priceChf: draft.priceChf,
        productType: product.type,
        podProvider: product.type === "pod" && product.pod ? `printify:${product.pod}` : null,
        imageUrl: image.url,
      });
      const validation = [...issues, ...gate.reasons.filter((reason) => !issues.some((item) => item.code === reason.code && item.message === reason.message))];
      if (!gate.pass) held++;
      await db.insert(listings).values({
        shopId: ctx.shopId,
        designId: design.id,
        keywordId: design.keywordId,
        niche: design.niche,
        productType: product.type,
        podProvider: product.type === "pod" ? `printify:${product.pod}` : null,
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
      await db.update(designs).set({ status: "listed" }).where(eq(designs.id, design.id));
      if (llmCost > 0) {
        await db.insert(costs).values({ shopId: ctx.shopId, kind: "ai_text", amountChf: llmCost, note: `${provider}: listing copy`, isDemo: ctx.demo });
      }
      const errors = issues.filter((i) => i.severity === "error").length;
      if (errors) invalid++;
      created++;
      log(`Listed “${draft.title.slice(0, 60)}…” at CHF ${draft.priceChf.toFixed(2)} → net ${fees.netChf.toFixed(2)} (${fees.marginPct}%)${errors ? ` · ${errors} validation error(s)` : ""}`);
    } catch (e) {
      log(`Listing failed for design #${design.id}: ${(e as Error).message}`, "error");
    }
  }
  const queued = created - held;
  if (queued) {
    await emit(db, {
      type: "approval.pending",
      title: `${queued} listing${queued > 1 ? "s" : ""} awaiting approval`,
      body: invalid ? `${invalid} need edits before they can be approved` : "Swipe to approve or reject",
      severity: "warning",
      href: "/queue",
    }, ctx.demo);
  }
  if (held) {
    await emit(db, {
      type: "quality.failed",
      title: `${held} listing${held > 1 ? "s" : ""} held by the quality gate`,
      body: "They stay off the approval queue. The dashboard lists each reason.",
      severity: "warning",
      href: "/",
    }, ctx.demo);
  }
  return `Drafted ${queued} listings for approval${held ? `, held ${held} for quality` : ""}${invalid ? ` (${invalid} need fixes)` : ""}`;
};
