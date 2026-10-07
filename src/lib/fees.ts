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

/**
 * Per-type net margin targets for Designed by Kai (CHF).
 * POD stays in the competitive 25–35% band. Digital stays at or above 75%.
 * A single global 55% target is what pushed mugs and posters onto niche ceilings.
 */
export const MARGIN_TARGETS = {
  podDefault: 30,
  podMin: 25,
  podMax: 35,
  digitalDefault: 75,
  digitalMin: 75,
  digitalMax: 85,
} as const;

export type PriceProductType = "digital" | "pod";

/** Clamp a settings value into the band for that product type. */
export function resolveTargetMargin(productType: PriceProductType, pct?: number) {
  if (productType === "pod") {
    const n = pct ?? MARGIN_TARGETS.podDefault;
    return Math.min(MARGIN_TARGETS.podMax, Math.max(MARGIN_TARGETS.podMin, n));
  }
  const n = pct ?? MARGIN_TARGETS.digitalDefault;
  return Math.min(MARGIN_TARGETS.digitalMax, Math.max(MARGIN_TARGETS.digitalMin, n));
}

/** Rounds up to a "retail" CHF price ending in .90 (e.g. 7.90, 24.90). */
export function retailRound(p: number) {
  const candidate = Math.ceil(p + 0.1) - 0.1;
  return round2(candidate);
}

/** Greatest CHF x.90 price that is still at or below `p` (20.40 → 19.90, 19.90 → 19.90). */
export function retailRoundDown(p: number) {
  if (!Number.isFinite(p)) throw new Error("Invalid price");
  const cents = Math.round(p * 100);
  if (cents <= 90) return 0.9;
  const whole = Math.floor(cents / 100);
  const frac = cents % 100;
  if (frac >= 90) return round2(whole + 0.9);
  return round2(whole - 1 + 0.9);
}

function marginEquation(opts: { targetMarginPct: number; podCostChf?: number; offsiteAds?: boolean }) {
  const m = opts.targetMarginPct / 100;
  const pod = opts.podCostChf ?? 0;
  const vatMul = 1 + FEES.vatOnFeesRate;
  const variableRate = (FEES.transactionRate + FEES.processingRate) * vatMul + (opts.offsiteAds ? FEES.offsiteAdsRate : 0);
  const fixed = (usdToChf(FEES.listingFeeUsd) + FEES.processingFixedChf) * vatMul + pod;
  const denom = 1 - variableRate - m;
  return { fixed, denom };
}

/** Smallest .90 price that reaches the target, or null when fees make it impossible. */
export function marginPrice(opts: { targetMarginPct: number; podCostChf?: number; offsiteAds?: boolean }) {
  const { fixed, denom } = marginEquation(opts);
  if (denom <= 0) return null;
  return retailRound(fixed / denom);
}

function profitable(price: number, opts: { podCostChf?: number; offsiteAds?: boolean }) {
  return calculateFees({ priceChf: price, podCostChf: opts.podCostChf, offsiteAds: opts.offsiteAds }).netChf > 0;
}

function clearsTarget(price: number, opts: { targetMarginPct: number; podCostChf?: number; offsiteAds?: boolean }) {
  if (!(price > 0)) return false;
  const margin = calculateFees({ priceChf: price, podCostChf: opts.podCostChf, offsiteAds: opts.offsiteAds }).marginPct;
  return margin >= opts.targetMarginPct - 0.05;
}

/**
 * CHF retail price for a listing.
 *
 * 1. Solve for the lowest `.90` price that hits `targetMarginPct` (retailRound up).
 * 2. When `competitorChf` is set and lower, round down toward that market price
 *    (`retailRoundDown`) only when the result still clears `targetMarginPct`.
 *    A merely profitable anchor (net above zero, margin in the teens) does not win.
 *    Digital prices are not pulled below the margin solution.
 * 3. Niche `minChf` / `maxChf` are soft guards. Digital uses the floor when the formula
 *    undershoots it. If the POD cap itself misses the target margin, the margin
 *    solution is used even when it sits above `maxChf`.
 * 4. Digital + Offsite Ads cannot reach 75% (fees alone approach ~26%). That case stays
 *    on the niche floor instead of climbing to the cap.
 */
export function suggestPrice(opts: {
  targetMarginPct: number;
  podCostChf?: number;
  offsiteAds?: boolean;
  minChf?: number;
  maxChf?: number;
  /** Typical competitor retail in CHF. Not a USD price. */
  competitorChf?: number;
  productType?: PriceProductType;
}): number {
  const productType: PriceProductType = opts.productType ?? ((opts.podCostChf ?? 0) > 0 ? "pod" : "digital");
  const solved = marginPrice(opts);
  const competitor = opts.competitorChf != null && opts.competitorChf > 0 ? retailRoundDown(opts.competitorChf) : undefined;

  if (solved == null) {
    if (productType === "digital" && opts.offsiteAds) {
      const floor = opts.minChf ?? competitor ?? 5.9;
      const capped = opts.maxChf != null ? Math.min(floor, opts.maxChf) : floor;
      return round2(capped);
    }
    throw new Error("Target margin is unreachable with Etsy fees");
  }

  let price = solved;
  if (productType === "pod" && competitor != null && competitor < solved && clearsTarget(competitor, opts)) {
    price = competitor;
  }

  if (productType === "digital" && opts.minChf != null && price < opts.minChf) price = opts.minChf;
  if (productType === "pod" && opts.minChf != null && price < opts.minChf && !profitable(price, opts)) price = opts.minChf;

  if (opts.maxChf != null && price > opts.maxChf) {
    if (competitor != null && competitor <= opts.maxChf && clearsTarget(competitor, opts)) price = competitor;
    else if (clearsTarget(opts.maxChf, opts)) price = opts.maxChf;
    else price = solved;
  }
  return round2(price);
}

/**
 * Typical POD base costs from the plan (Printful Enhanced Matte A3 USD 10.90 + US shipping USD 4.99).
 * `marketAnchorChf` is the typical competitor retail in CHF (cozy mugs ~CHF 15–25, wall prints ~CHF 18–33).
 * It is a CHF anchor, not a converted USD shelf price.
 */
export const POD_PRESETS = {
  posterA3: { label: "Poster A3 (matte)", baseUsd: 10.9, shippingUsd: 4.99, marketAnchorChf: 24.9 },
  mug: { label: "Mug 11oz", baseUsd: 5.9, shippingUsd: 5.49, marketAnchorChf: 19.9 },
  tshirt: { label: "Unisex tee", baseUsd: 9.25, shippingUsd: 4.75, marketAnchorChf: 24.9 },
  sweatshirt: { label: "Crewneck sweatshirt", baseUsd: 17.5, shippingUsd: 6.99, marketAnchorChf: 36.9 },
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
