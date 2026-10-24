import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { getLLMProvider, type LLMProvider } from "@/adapters/llm";
import { getPrintifyAdapter } from "@/adapters/printify";
import type { SupplierProduct } from "@/adapters/supplier/types";
import { costs, designs, keywords, listings } from "@/db/schema";
import type { Niche, ProductType } from "@/db/schema";
import { alignDeliveryCopy, defaultDeliverable, leadPhrase, measuredDigitalDeliverable, removeUndeliverablePromises } from "@/lib/delivery";
import { appendProviderDetails, validProviderDetails, withDisclosures, type ProviderDetails } from "@/lib/disclosures";
import { emit } from "@/lib/events";
import { calculateFees, DEFAULT_POD_PRESETS, podCostChf, POD_PRESETS, resolveTargetMargin, suggestPrice, type PodPreset } from "@/lib/fees";
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
import { getPrintTarget, hasMinimumPixels, PRINT_TARGETS, type PrintTargetKey } from "@/lib/print-targets";
import { stageResult, type StageContext, type StageFn } from "./types";
import { sourcedListingCosts } from "./sourcing";

export function pickProduct(niche: Niche, r: number): { type: ProductType; pod?: PodPreset } {
  const mix = NICHES[niche].productMix;
  let acc = 0;
  for (const m of mix) {
    acc += m.weight;
    if (r < acc) return { type: m.type, pod: m.pod };
  }
  return { type: mix[0].type, pod: mix[0].pod };
}

/** Enabled product nouns override the niche mix without changing the default mix. */
export function productForPhrase(niche: Niche, phrase: string, random: number, enabled?: readonly PodPreset[]): { type: ProductType; pod?: PodPreset } {
  const extra: [PodPreset, RegExp][] = [
    ["tote", /\btote(?: bags?)?\b/i], ["phoneCase", /\bphone cases?\b/i],
    ["canvas", /\b(?:canvas|canvases)\b/i], ["sticker", /\bstickers?\b/i],
    ["blanket", /\bblankets?\b/i], ["hoodie", /\bhoodies?\b/i], ["ornament", /\bornaments?\b/i],
  ];
  const named = extra.find(([preset, pattern]) => enabled?.includes(preset) && pattern.test(phrase));
  if (named) return { type: "pod", pod: named[0] };
  const wantsSweat = /\bsweatshirts?\b/i.test(phrase);
  const wantsMug = /\bmugs?\b/i.test(phrase);
  const wantsPoster = /\bposters?\b/i.test(phrase);
  const wantsShirt = !wantsSweat && /\b(?:t-?shirts?|tees?)\b/i.test(phrase);
  const preferred = wantsMug ? "mug" : wantsPoster ? "posterA3" : wantsSweat ? "sweatshirt" : wantsShirt ? "tshirt" : null;
  if (preferred && (!enabled || enabled.includes(preferred))) {
    const match = NICHES[niche].productMix.find((item) => item.pod === preferred);
    if (match) return { type: match.type, pod: match.pod };
  }
  const fallback = pickProduct(niche, random);
  return fallback.pod && enabled && !enabled.includes(fallback.pod) ? { type: "digital" } : fallback;
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
  podCostChf?: number;
  llm?: LLMProvider;
  /** Demo shops may use the template writer. Live shops require a real LLM provider. */
  demo?: boolean;
  deliveryFormat?: "png" | "jpeg" | "webp" | null;
  deliveryPixels?: { width: number; height: number } | null;
  providerDetails?: ProviderDetails | null;
  artDirection?: string;
  siblingTitles?: readonly string[];
}) {
  const llm = opts.llm ?? getLLMProvider({ demo: opts.demo });
  const keyword = leadPhrase(productKeyword(opts.keyword) ? opts.keyword : "", opts.niche, opts.product.type, opts.product.pod);
  const copy = await llm.writeListing({
    keyword,
    niche: opts.niche,
    productType: opts.product.type,
    podPreset: opts.product.pod,
    seed: opts.seed,
    artDirection: opts.artDirection,
  });
  const product = opts.product.type === "digital" ? "digital" : opts.product.pod ?? "posterA3";
  const title = buildProductTitle(keyword, copy.title, product, opts.siblingTitles, opts.artDirection);
  const styleClaims = /\b(?:engraving|etched|watercolor|oil painting|linocut|photograph|vintage)\b/i;
  const tags = copy.tags.filter((tag) => !styleClaims.test(tag));
  const preset = opts.product.pod ?? "posterA3";
  const pod = opts.product.type === "pod" ? (opts.podCostChf ?? podCostChf(preset)) : 0;
  if (pod == null) throw new Error(`Unverified supplier cost for ${preset}; pricing unavailable.`);
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
  const facts = opts.product.type === "digital"
    ? measuredDigitalDeliverable(opts.deliveryFormat ?? null, opts.deliveryPixels)
    : defaultDeliverable("pod");
  if (opts.product.type === "pod" && opts.product.pod === "ornament") facts.blank = "ornament";
  if (opts.product.type === "pod" && opts.deliveryPixels) {
    facts.dpi = 300;
    facts.sizes = [
      `${(opts.deliveryPixels.width / 300).toFixed(1)}×${(opts.deliveryPixels.height / 300).toFixed(1)} in`,
      `${(opts.deliveryPixels.width / 150).toFixed(1)}×${(opts.deliveryPixels.height / 150).toFixed(1)} in`,
    ];
  }
  let description = withDisclosures(alignDeliveryCopy(copy.body, opts.product.type, opts.deliveryFormat ?? null, facts), opts.product.type);
  if (opts.product.type === "pod" && validProviderDetails(opts.providerDetails)) {
    description = appendProviderDetails(description, opts.providerDetails);
  }
  const repaired = repairTrivialCopy(
    {
      title,
      tags,
      description,
      priceChf,
      productType: opts.product.type,
      deliverable: facts,
      podPreset: opts.product.pod,
      providerDetails: opts.providerDetails,
    },
    { keyword: productKeyword(keyword), product: opts.product },
  );
  const stripped = repairTrivialCopy({
    ...repaired.draft,
    title: removeUndeliverablePromises(repaired.draft.title, facts),
    tags: repaired.draft.tags.filter((tag) => !removeUndeliverablePromises(tag, facts).trim() || removeUndeliverablePromises(tag, facts) === tag)
      .map((tag) => removeUndeliverablePromises(tag, facts))
      .filter(Boolean),
    description: repaired.draft.description.split("\n").filter((line) => !removeUndeliverablePromises(line, facts).trim() || removeUndeliverablePromises(line, facts) === line).join("\n"),
  }, { keyword: productKeyword(keyword), product: opts.product });
  const draft = stripped.draft;
  const fees = calculateFees({ priceChf, podCostChf: pod, offsiteAds: opts.priceChf != null ? true : opts.assumeOffsiteAds });
  const { issues } = validateListing({ ...draft, primaryPhrase: productKeyword(keyword) });
  return {
    draft,
    fees,
    issues,
    pod,
    llmCost: copy.costChf,
    provider: copy.provider,
    fixes: [...repaired.fixes, ...stripped.fixes, ...(repaired.draft.title !== draft.title ? ["removed undeliverable title claims"] : [])],
  };
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
  siblingTitles: string[],
  supplierId = "printify",
  supplierProduct?: SupplierProduct,
) {
  const podProvider = rung.product.type === "pod" && rung.product.pod ? `${supplierId}:${rung.product.pod}` : null;
  const dryRunOnly = rung.product.type === "pod" && (supplierId !== "printify" || !DEFAULT_POD_PRESETS.includes(rung.product.pod!));
  const image = await listingImageForProduct({
    productType: rung.product.type,
    artworkUrl,
    preset: rung.product.pod,
    niche: design.niche,
    sourceDimensions: design.imageWidth && design.imageHeight ? { width: design.imageWidth, height: design.imageHeight } : undefined,
  });
  if (containsInlineImage(image.url)) throw new Error("Refusing to store an inline gallery image.");
  const deliveryUrl = rung.product.type === "digital" ? artworkUrl : null;
  const fileManifest = deliveryUrl ? await buildFileManifest(deliveryUrl, image.url) : null;
  let providerDetails: ProviderDetails | undefined;
  if (rung.product.type === "pod" && supplierId === "printify" && rung.product.pod) {
    try {
      const adapter = await getPrintifyAdapter({ db: ctx.db, intent: "read" });
      if (ctx.demo || adapter.mode === "live") providerDetails = await adapter.getProviderDetails?.(rung.product.pod);
    } catch {
      // Unavailable provider facts hold the draft; never replace them with estimates.
    }
  }
  const { draft, fees, issues, pod, llmCost, provider, fixes } = await draftListing({
    niche: design.niche,
    keyword: keywordForRung(phrase, rung),
    product: rung.product,
    seed: design.id,
    podTargetMarginPct: automation.podTargetMarginPct,
    digitalTargetMarginPct: automation.digitalTargetMarginPct,
    assumeOffsiteAds: automation.assumeOffsiteAds,
    priceChf: rung.priceChf,
    podCostChf: rung.podCostChf,
    llm,
    deliveryFormat: fileManifest?.delivery.format ?? (rung.product.type === "digital" ? "png" : null),
    deliveryPixels: fileManifest?.delivery
      ? { width: fileManifest.delivery.width, height: fileManifest.delivery.height }
      : design.imageWidth && design.imageHeight
        ? { width: design.imageWidth, height: design.imageHeight }
        : null,
    providerDetails,
    artDirection: design.prompt,
    siblingTitles,
  });
  const gate = evaluateQualityGate({
    title: draft.title,
    tags: draft.tags,
    description: draft.description,
    priceChf: draft.priceChf,
    productType: rung.product.type,
    podProvider,
    imageUrl: image.url,
    gallery: image.gallery,
    isDemo: ctx.demo,
    artworkUrl,
    printWidth: design.imageWidth,
    printHeight: design.imageHeight,
    colorVariance: design.colorVariance,
    printTargetKey: (rung.id === "digital-mid" ? "digitalLarge" : rung.product.type === "digital" ? "digital" : rung.product.pod) as PrintTargetKey,
    printTarget: rung.product.type === "pod" && rung.product.pod ? await getPrintTarget(rung.product.pod) : undefined,
    upscaleMethod: design.upscaleMethod,
  });
  for (const issue of issues.filter((issue) => issue.severity === "error")) {
    gate.pass = false;
    if (!gate.reasons.some((reason) => reason.code === issue.code && reason.message === issue.message)) gate.reasons.push(issue);
  }
  if (dryRunOnly) {
    gate.pass = false;
    gate.reasons.push({ field: "description", code: "supplier_dry_run", severity: "error", message: "This supplier/product type is dry-run only; live fulfillment is not enabled." });
  }
  const validation = [...issues, ...gate.reasons.filter((reason) => !issues.some((item) => item.code === reason.code && item.message === reason.message))];
  if (validation.some((item) => item.code === "undeliverable_promise")) {
    throw new Error("Refusing to create a listing with an undeliverable promise.");
  }
  if (rung.costIsEstimate) {
    validation.push({ field: "price", code: "sourcing_estimate", severity: "warning", message: "POD cost is a preset estimate; no fresh verified sourcing quote." });
  }
  const awaitingSupplierPreparation = gate.reasons.length > 0 &&
    gate.reasons.every((reason) =>
      reason.code === "supplier_mockups_pending" || reason.code === "missing_provider_timings" ||
      (reason.code === "supplier_preview_error" && reason.message.startsWith("No Printify blank pinned for ")));
  await ctx.db.insert(listings).values({
    shopId: ctx.shopId,
    designId: design.id,
    keywordId: design.keywordId,
    niche: design.niche,
    productType: rung.product.type,
    podProvider,
    supplier: rung.product.type === "pod" ? supplierId : null,
    supplierProductId: supplierProduct?.uid ?? null,
    podBlueprintId: supplierProduct?.blueprintId ?? null,
    podPrintProviderId: supplierProduct?.printProviderId ?? null,
    title: draft.title,
    tags: draft.tags,
    description: draft.description,
    imageUrl: image.url,
    gallery: image.gallery ?? [],
    copyProvenance: {
      version: 1, provider,
      ...(validProviderDetails(providerDetails) ? { providerDetails } : {}),
      inputSha256: createHash("sha256").update(JSON.stringify({
        version: "listing-input-v1", phrase: keywordForRung(phrase, rung),
        niche: design.niche, product: rung.product, seed: design.id, artDirection: design.prompt,
      })).digest("hex"),
    },
    deliveryUrl,
    fileManifest,
    priceChf: draft.priceChf,
    podCostChf: pod,
    netChf: fees.netChf,
    marginPct: fees.marginPct,
    validation,
    status: gate.pass || awaitingSupplierPreparation ? "pending_approval" : "quality_failed",
    isDemo: ctx.demo,
  });
  siblingTitles.push(draft.title);
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
    passed: gate.pass || awaitingSupplierPreparation,
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
  const podSettings = await getSetting(db, "podProducts");
  const quoted = await sourcedListingCosts(db, podSettings.enabledPresets, ctx.now);
  log(`Listing writer: ${llm.name}${llm.name === "mock-template" ? " (DEMO template copy)" : ""}`);

  let created = 0;
  let held = 0;
  let invalid = 0;
  let rungFailures = 0;
  const notes: string[] = [];
  for (const { design, phrase } of pending) {
    if (!ctx.demo && design.qualityScore == null) {
      await db.update(designs).set({ status: "needs_review", qualityReasons: ["Image quality assessment required."] }).where(eq(designs.id, design.id));
      log(`Unassessed design #${design.id} needs review before Listing`, "warn");
      continue;
    }
    if (!ctx.demo && (!Number.isInteger(design.qualityScore) || design.qualityScore! < MIN_DESIGN_SCORE || design.qualityScore! > 10 || design.qualityReasons.length)) {
      await db.update(designs).set({ status: "rejected", qualityReasons: [...design.qualityReasons, "No passing image quality assessment."] }).where(eq(designs.id, design.id));
      log(`Rejected failed image assessment for design #${design.id} before Listing`, "warn");
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
    const siblingTitles: string[] = [];
    for (const rung of quoteLadder(design.niche, podSettings.enabledPresets, quoted.costs, quoted.estimates)) {
      if (rung.id === "digital-mid") {
        const target = PRINT_TARGETS.digitalLarge;
        const largeEnough = hasMinimumPixels(design.imageWidth, design.imageHeight, target);
        const hasAiUpscale = design.upscaleMethod === "realesrgan" || design.upscaleMethod === "native";
        if (!largeEnough || !hasAiUpscale) {
          log(`Skipped Large digital print for design #${design.id}: file is ${design.imageWidth ?? "?"}×${design.imageHeight ?? "?"}px; an AI-upscaled file of at least ${target.minW}×${target.minH}px is required.`, "warn");
          continue;
        }
      }
      try {
        const preset = rung.product.pod;
        const made = await listRung(ctx, design, phraseText, rung, artworkUrl, automation, llm, siblingTitles,
          preset ? quoted.suppliers[preset] ?? podSettings.suppliers[preset] ?? "printify" : "printify", preset ? quoted.products[preset] : undefined);
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
  const status = held > 0 || invalid > 0 ? "warning" : yieldStatus(created, rungFailures);
  if (status === "success") return summary;
  return stageResult(summary, status);
};
