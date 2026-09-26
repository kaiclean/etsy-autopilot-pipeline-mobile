/**
 * Etsy fee model for a Swiss seller listing in CHF (business plan §6).
 * Sources: etsy.com/legal/fees, Etsy Payments CH processing table, VAT on seller fees.
 */
export const FEES = {
  usdToChf: 0.8278,
  listingFeeUsd: 0.2,
  transactionRate: 0.065,
  processingRate: 0.04,
  processingFixedChf: 0.5,
  vatOnFeesRate: 0.081,
  offsiteAdsRate: 0.15,
} as const;

export type FeeInput = {
  priceChf: number;
  shippingChf?: number;
  /** POD base + shipping cost paid to the print partner, already in CHF. */
  podCostChf?: number;
  offsiteAds?: boolean;
  quantity?: number;
};

export type FeeBreakdown = {
  revenueChf: number;
  listingFeeChf: number;
  transactionFeeChf: number;
  processingFeeChf: number;
  vatOnFeesChf: number;
  offsiteAdsFeeChf: number;
  podCostChf: number;
  totalEtsyFeesChf: number;
  netChf: number;
  marginPct: number;
};

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function usdToChf(usd: number) {
  return usd * FEES.usdToChf;
}

/**
 * Full-precision math, rounded only at the output so line items reconcile with §6
 * (digital CHF 8.00 → net 6.37; POD poster CHF 29 → net 11.84).
 * Offsite Ads fee is applied without VAT to match the plan's worked example.
 */
export function calculateFees(input: FeeInput): FeeBreakdown {
  const qty = input.quantity ?? 1;
  const price = input.priceChf * qty;
  const shipping = input.shippingChf ?? 0;
  const revenue = price + shipping;

  const listing = usdToChf(FEES.listingFeeUsd) * qty;
  const transaction = revenue * FEES.transactionRate;
  const processing = revenue * FEES.processingRate + FEES.processingFixedChf;
  const vat = (listing + transaction + processing) * FEES.vatOnFeesRate;
  const offsite = input.offsiteAds ? revenue * FEES.offsiteAdsRate : 0;
  const pod = (input.podCostChf ?? 0) * qty;

  const etsyFees = listing + transaction + processing + vat + offsite;
  const net = revenue - etsyFees - pod;

  return {
    revenueChf: round2(revenue),
    listingFeeChf: round2(listing),
    transactionFeeChf: round2(transaction),
    processingFeeChf: round2(processing),
    vatOnFeesChf: round2(vat),
    offsiteAdsFeeChf: round2(offsite),
    podCostChf: round2(pod),
    totalEtsyFeesChf: round2(etsyFees),
    netChf: round2(net),
    marginPct: revenue > 0 ? round2((net / revenue) * 100) : 0,
  };
}

/** Rounds up to a "retail" CHF price ending in .90 (e.g. 7.90, 24.90). */
export function retailRound(p: number) {
  const candidate = Math.ceil(p + 0.1) - 0.1;
  return round2(candidate);
}

/**
 * Smallest retail price reaching `targetMarginPct` net margin after Etsy fees + POD cost.
 * Solves net(p) = m·p analytically, then applies retail rounding.
 */
export function suggestPrice(opts: {
  targetMarginPct: number;
  podCostChf?: number;
  offsiteAds?: boolean;
  minChf?: number;
  maxChf?: number;
}): number {
  const m = opts.targetMarginPct / 100;
  const pod = opts.podCostChf ?? 0;
  const vatMul = 1 + FEES.vatOnFeesRate;
  const variableRate = (FEES.transactionRate + FEES.processingRate) * vatMul + (opts.offsiteAds ? FEES.offsiteAdsRate : 0);
  const fixed = (usdToChf(FEES.listingFeeUsd) + FEES.processingFixedChf) * vatMul + pod;
  const denom = 1 - variableRate - m;
  if (denom <= 0) throw new Error("Target margin is unreachable with Etsy fees");
  let price = retailRound(fixed / denom);
  if (opts.minChf !== undefined) price = Math.max(price, opts.minChf);
  if (opts.maxChf !== undefined) price = Math.min(price, opts.maxChf);
  return round2(price);
}

/** Typical POD base costs from the plan (Printful Enhanced Matte A3 USD 10.90 + US shipping USD 4.99). */
export const POD_PRESETS = {
  posterA3: { label: "Poster A3 (matte)", baseUsd: 10.9, shippingUsd: 4.99 },
  mug: { label: "Mug 11oz", baseUsd: 5.9, shippingUsd: 5.49 },
  tshirt: { label: "Unisex tee", baseUsd: 9.25, shippingUsd: 4.75 },
  sweatshirt: { label: "Crewneck sweatshirt", baseUsd: 17.5, shippingUsd: 6.99 },
} as const;

export type PodPreset = keyof typeof POD_PRESETS;

export function podCostChf(preset: PodPreset) {
  const p = POD_PRESETS[preset];
  return round2(usdToChf(p.baseUsd + p.shippingUsd));
}

export function productLabel(productType: "digital" | "pod", podProvider?: string | null) {
  if (productType === "digital") return "Digital download";
  const preset = podProvider?.split(":")[1] as PodPreset | undefined;
  return `POD · ${preset && POD_PRESETS[preset] ? POD_PRESETS[preset].label : "print"}`;
}
