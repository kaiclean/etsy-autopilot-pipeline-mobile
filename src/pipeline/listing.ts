import { eq } from "drizzle-orm";
import { getLLMProvider, type LLMProvider } from "@/adapters/llm";
import { costs, designs, keywords, listings } from "@/db/schema";
import type { Niche, ProductType } from "@/db/schema";
import { isDemoMode } from "@/lib/config";
import { alignDeliveryCopy, leadPhrase } from "@/lib/delivery";
import { withDisclosures } from "@/lib/disclosures";
import { emit } from "@/lib/events";
import { calculateFees, podCostChf, POD_PRESETS, resolveTargetMargin, suggestPrice, type PodPreset } from "@/lib/fees";
import { sanitizeDraft, validateListing } from "@/lib/listing-validator";
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
  let invalid = 0;
  for (const { design, phrase } of pending) {
    if (isNichePaused(design.niche)) {
      await db.update(designs).set({ status: "discarded" }).where(eq(designs.id, design.id));
      log(`Skipped design #${design.id}: ${NICHES[design.niche].pausedReason}`, "warn");
      continue;
    }
    const product = pickProduct(design.niche, ctx.random());
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
      const image = await listingImageForProduct({
        productType: product.type,
        artworkUrl: design.imageUrl,
        preset: product.pod,
        niche: design.niche,
      });
      const deliveryUrl = product.type === "digital" ? design.imageUrl : null;
      const fileManifest = deliveryUrl ? tryBuildFileManifest(deliveryUrl, image.url) : null;
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
        validation: issues,
        status: "pending_approval",
        isDemo: isDemoMode(),
      });
      await db.update(designs).set({ status: "listed" }).where(eq(designs.id, design.id));
      if (llmCost > 0) {
        await db.insert(costs).values({ shopId: ctx.shopId, kind: "ai_text", amountChf: llmCost, note: `${provider}: listing copy`, isDemo: isDemoMode() });
      }
      const errors = issues.filter((i) => i.severity === "error").length;
      if (errors) invalid++;
      created++;
      log(`Listed “${draft.title.slice(0, 60)}…” at CHF ${draft.priceChf.toFixed(2)} → net ${fees.netChf.toFixed(2)} (${fees.marginPct}%)${errors ? ` · ${errors} validation error(s)` : ""}`);
    } catch (e) {
      log(`Listing failed for design #${design.id}: ${(e as Error).message}`, "error");
    }
  }
  if (created) {
    await emit(db, {
      type: "approval.pending",
      title: `${created} listing${created > 1 ? "s" : ""} awaiting approval`,
      body: invalid ? `${invalid} need edits before they can be approved` : "Swipe to approve or reject",
      severity: "warning",
      href: "/queue",
    });
  }
  return `Drafted ${created} listings for approval${invalid ? ` (${invalid} need fixes)` : ""}`;
};
