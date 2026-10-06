import type { ValidationIssue } from "@/db/schema";
import {
  FEE_SCHEDULE,
  REFERENCE_USD_TO_CHF,
  assumedBuyerTaxRate,
  resolveUsdToChf,
} from "@/lib/fee-schedule";

/**
 * Dated Etsy CH rates plus the reference USD→CHF rate.
 * `calculateFees` uses `USD_TO_CHF` when set, otherwise this reference rate.
 * Offsite Ads VAT, the 12% tier, and the USD 100 cap live in `FEE_SCHEDULE`.
 */
export const FEES = {
  usdToChf: REFERENCE_USD_TO_CHF,
  listingFeeUsd: FEE_SCHEDULE.listingFeeUsd,
  transactionRate: FEE_SCHEDULE.transactionRate,
  processingRate: FEE_SCHEDULE.processingRate,
  processingFixedChf: FEE_SCHEDULE.processingFixedChf,
  vatOnFeesRate: FEE_SCHEDULE.vatOnFeesRate,
  offsiteAdsRate: FEE_SCHEDULE.offsiteAdsRate,
} as const;

export type FeeInput = {
  priceChf: number;
  shippingChf?: number;
  /** POD blank + shipping paid to the print partner, already in CHF. */
  podCostChf?: number;
  offsiteAds?: boolean;
  quantity?: number;
  /**
   * Destination VAT Etsy collects, as a fraction of seller revenue (item + shipping − discount).
   * Processing is charged on the tax-inclusive total. Default 0 for suggested prices.
   */
  buyerTaxRate?: number;
  /** Trailing 365-day sales in USD. At or above USD 10,000 the Offsite Ads rate is 12%. */
  trailingSalesUsd?: number;
  /** Per-call FX. Defaults to USD_TO_CHF, then the 24 Sep 2026 reference rate. */
  usdToChf?: number;
};

export type FeeBreakdown = {
  revenueChf: number;
  listingFeeChf: number;
  transactionFeeChf: number;
  processingFeeChf: number;
  vatOnFeesChf: number;
  offsiteAdsFeeChf: number;
  offsiteAdsRate: number;
  offsiteAdsCapped: boolean;
  podCostChf: number;
  totalEtsyFeesChf: number;
  netChf: number;
  marginPct: number;
};

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function activeUsdToChf(override?: number) {
  if (override != null && Number.isFinite(override) && override > 0) return override;
  return resolveUsdToChf().rate;
}

export function usdToChf(usd: number, rate = activeUsdToChf()) {
  return usd * rate;
}

export function listingFeeChf(rate = activeUsdToChf()) {
  return round2(usdToChf(FEE_SCHEDULE.listingFeeUsd, rate) * (1 + FEE_SCHEDULE.vatOnFeesRate));
}

export function offsiteAdsRateFor(trailingSalesUsd?: number) {
  if (trailingSalesUsd != null && trailingSalesUsd >= FEE_SCHEDULE.offsiteAdsReducedAfterUsd) {
    return FEE_SCHEDULE.offsiteAdsReducedRate;
  }
  return FEE_SCHEDULE.offsiteAdsRate;
}

/**
 * Full-precision math, rounded only at the output.
 * Swiss VAT applies to every Etsy fee, including Offsite Ads.
 * The Offsite Ads fee is min(rate × revenue, USD 100 in CHF).
 * Processing uses the tax-inclusive total when `buyerTaxRate` is set.
 */
export function calculateFees(input: FeeInput): FeeBreakdown {
  const qty = input.quantity ?? 1;
  const fx = activeUsdToChf(input.usdToChf);
  const price = input.priceChf * qty;
  const shipping = input.shippingChf ?? 0;
  const revenue = price + shipping;
  const buyerTax = input.buyerTaxRate ?? 0;
  const processingBase = revenue * (1 + buyerTax);

  const listing = usdToChf(FEE_SCHEDULE.listingFeeUsd, fx) * qty;
  const transaction = revenue * FEE_SCHEDULE.transactionRate;
  const processing = processingBase * FEE_SCHEDULE.processingRate + FEE_SCHEDULE.processingFixedChf;
  const offsiteRate = input.offsiteAds ? offsiteAdsRateFor(input.trailingSalesUsd) : 0;
  const offsiteRaw = revenue * offsiteRate;
  const offsiteCap = FEE_SCHEDULE.offsiteAdsCapUsd * fx;
  const offsiteCapped = offsiteRate > 0 && offsiteRaw > offsiteCap;
  const offsite = offsiteCapped ? offsiteCap : offsiteRaw;
  const vat = (listing + transaction + processing + offsite) * FEE_SCHEDULE.vatOnFeesRate;
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
    offsiteAdsRate: offsiteRate,
    offsiteAdsCapped: offsiteCapped,
    podCostChf: round2(pod),
    totalEtsyFeesChf: round2(etsyFees),
    netChf: round2(net),
    marginPct: revenue > 0 ? round2((net / revenue) * 100) : 0,
  };
}

/**
 * Per-type net margin targets for Designed by Kai (CHF).
 * POD stays in the competitive 25–35% band. Digital stays at or above 75% when fees allow it.
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

export type PriceOpts = {
  targetMarginPct: number;
  podCostChf?: number;
  offsiteAds?: boolean;
  minChf?: number;
  maxChf?: number;
  /** Typical competitor retail in CHF. Not a scraped price. */
  competitorChf?: number;
  productType?: PriceProductType;
  buyerTaxRate?: number;
  trailingSalesUsd?: number;
  usdToChf?: number;
};

/** Clamp a settings value into the band for that product type. */
export function resolveTargetMargin(productType: PriceProductType, pct?: number) {
  if (productType === "pod") {
    const n = pct ?? MARGIN_TARGETS.podDefault;
    return Math.min(MARGIN_TARGETS.podMax, Math.max(MARGIN_TARGETS.podMin, n));
  }
  const n = pct ?? MARGIN_TARGETS.digitalDefault;
  return Math.min(MARGIN_TARGETS.digitalMax, Math.max(MARGIN_TARGETS.digitalMin, n));
}

/** Rounds up to a CHF price ending in .90 (e.g. 7.90, 24.90). */
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

function feeContext(opts: PriceOpts) {
  return {
    podCostChf: opts.podCostChf,
    offsiteAds: opts.offsiteAds,
    buyerTaxRate: opts.buyerTaxRate ?? assumedBuyerTaxRate(),
    trailingSalesUsd: opts.trailingSalesUsd,
    usdToChf: opts.usdToChf,
  };
}

function marginEquation(opts: PriceOpts, offsiteAsFixedChf = 0) {
  const m = opts.targetMarginPct / 100;
  const pod = opts.podCostChf ?? 0;
  const fx = activeUsdToChf(opts.usdToChf);
  const vatMul = 1 + FEE_SCHEDULE.vatOnFeesRate;
  const buyer = 1 + (opts.buyerTaxRate ?? assumedBuyerTaxRate());
  const offsiteRate = offsiteAsFixedChf > 0 ? 0 : opts.offsiteAds ? offsiteAdsRateFor(opts.trailingSalesUsd) : 0;
  const variableRate =
    FEE_SCHEDULE.transactionRate * vatMul + FEE_SCHEDULE.processingRate * buyer * vatMul + offsiteRate * vatMul;
  const fixed =
    (usdToChf(FEE_SCHEDULE.listingFeeUsd, fx) + FEE_SCHEDULE.processingFixedChf) * vatMul + offsiteAsFixedChf * vatMul + pod;
  return { fixed, denom: 1 - variableRate - m, offsiteRate, fx };
}

/** Smallest .90 price that reaches the target, or null when fees make it impossible. */
export function marginPrice(opts: PriceOpts): number | null {
  const solved = solveMargin(opts);
  if (solved == null) return null;
  return bumpToTarget(solved, opts);
}

function solveMargin(opts: PriceOpts): number | null {
  const linear = marginEquation(opts);
  if (linear.denom <= 0) return null;
  let raw = linear.fixed / linear.denom;
  if (opts.offsiteAds && linear.offsiteRate > 0) {
    const cap = FEE_SCHEDULE.offsiteAdsCapUsd * linear.fx;
    if (raw * linear.offsiteRate > cap) {
      const capped = marginEquation(opts, cap);
      if (capped.denom <= 0) return null;
      raw = capped.fixed / capped.denom;
    }
  }
  return raw;
}

function bumpToTarget(raw: number, opts: PriceOpts) {
  let price = retailRound(raw);
  const ctx = feeContext(opts);
  for (let i = 0; i < 12; i++) {
    const margin = calculateFees({ priceChf: price, ...ctx }).marginPct;
    if (margin + 1e-6 >= opts.targetMarginPct) return price;
    price = retailRound(price + 1);
  }
  return price;
}

function productOf(opts: PriceOpts): PriceProductType {
  return opts.productType ?? ((opts.podCostChf ?? 0) > 0 ? "pod" : "digital");
}

/** POD: at least the 25% minimum. Digital: at least cost plus Etsy fees (net ≥ 0). */
export function meetsPriceFloor(priceChf: number, opts: PriceOpts) {
  if (!(priceChf > 0) || !Number.isFinite(priceChf)) return false;
  const fees = calculateFees({ priceChf, ...feeContext(opts) });
  if (productOf(opts) === "pod") return fees.marginPct + 1e-6 >= MARGIN_TARGETS.podMin;
  return fees.netChf >= 0;
}

/** Lowest .90 price that clears the floor for this cost and fee assumption. */
export function minimumRetailPrice(opts: Omit<PriceOpts, "targetMarginPct"> & { productType: PriceProductType }) {
  const target = opts.productType === "pod" ? MARGIN_TARGETS.podMin : 0;
  const raw = solveMargin({ ...opts, targetMarginPct: target });
  let price = raw == null ? retailRound((opts.podCostChf ?? 0) + 1) : retailRound(Math.max(raw, 0.2));
  for (let i = 0; i < 24 && !meetsPriceFloor(price, { ...opts, targetMarginPct: target }); i++) {
    price = retailRound(price + 1);
  }
  return price;
}

export function priceFloorIssue(opts: {
  priceChf: number;
  productType: PriceProductType;
  podCostChf?: number;
  offsiteAds?: boolean;
  buyerTaxRate?: number;
  trailingSalesUsd?: number;
  usdToChf?: number;
}): ValidationIssue | null {
  const priceOpts: PriceOpts = { ...opts, targetMarginPct: opts.productType === "pod" ? MARGIN_TARGETS.podMin : 0 };
  if (meetsPriceFloor(opts.priceChf, priceOpts)) return null;
  const floor = minimumRetailPrice({ ...opts, productType: opts.productType });
  const fees = calculateFees({ priceChf: opts.priceChf, ...feeContext(priceOpts) });
  if (opts.productType === "pod") {
    return {
      field: "price",
      severity: "error",
      code: "price_below_margin_floor",
      message: `CHF ${opts.priceChf.toFixed(2)} keeps about ${fees.marginPct.toFixed(1)}% after fees and print cost. POD prices must stay at or above the ${MARGIN_TARGETS.podMin}% minimum (CHF ${floor.toFixed(2)} for this cost). Raise the price before approving.`,
    };
  }
  return {
    field: "price",
    severity: "error",
    code: "price_below_cost_floor",
    message: `CHF ${opts.priceChf.toFixed(2)} is below Etsy fees (net CHF ${fees.netChf.toFixed(2)}). Digital prices must cover cost plus fees (CHF ${floor.toFixed(2)} or more). Raise the price before approving.`,
  };
}

/**
 * CHF retail price for a listing.
 *
 * The floor is applied after the competitor anchor and the niche ceiling.
 * POD cannot land below the 25% minimum. Digital cannot land below cost plus fees.
 * A competitor anchor or a niche max that would break the floor is ignored.
 * Digital + Offsite Ads cannot reach 75% (variable fees including VAT are about 27.6%,
 * so the margin tops out near 72%). That case uses the top of the niche band, where
 * the margin is closest to the target, instead of a hard-coded CHF 5.90.
 */
export function suggestPrice(opts: PriceOpts): number {
  const productType = productOf(opts);
  const floor = minimumRetailPrice({ ...opts, productType });
  const solved = marginPrice(opts);
  const competitor =
    opts.competitorChf != null && opts.competitorChf > 0 ? retailRoundDown(opts.competitorChf) : undefined;

  let price: number;
  if (solved == null) {
    if (!(productType === "digital" && opts.offsiteAds)) {
      throw new Error("Target margin is unreachable with Etsy fees");
    }
    price = opts.maxChf != null ? retailRoundDown(opts.maxChf) : (opts.minChf ?? floor);
  } else {
    price = solved;
    if (productType === "pod" && competitor != null && competitor < price && meetsPriceFloor(competitor, opts)) {
      price = competitor;
    }
    if (productType === "digital" && opts.minChf != null && price < opts.minChf) price = opts.minChf;
    if (opts.maxChf != null && price > opts.maxChf) {
      const capped = retailRoundDown(opts.maxChf);
      if (meetsPriceFloor(capped, opts)) price = capped;
    }
  }

  if (!meetsPriceFloor(price, opts) || price < floor) price = floor;
  return round2(price);
}

/**
 * Fallback POD costs when Printify does not return a variant cost and CH/EU shipping.
 * These are Printful blanks plus US shipping from the business plan, not a Printify quote.
 * `marketAnchorChf` is a static competitor retail in CHF. It is not scraped from Etsy.
 */
export const POD_PRESETS = {
  posterA3: { label: "Poster A3 (matte)", baseUsd: 10.9, shippingUsd: 4.99, marketAnchorChf: 24.9 },
  mug: { label: "Mug 11oz", baseUsd: 5.9, shippingUsd: 5.49, marketAnchorChf: 19.9 },
  tshirt: { label: "Unisex tee", baseUsd: 9.25, shippingUsd: 4.75, marketAnchorChf: 24.9 },
  sweatshirt: { label: "Crewneck sweatshirt", baseUsd: 17.5, shippingUsd: 6.99, marketAnchorChf: 36.9 },
} as const;

export type PodPreset = keyof typeof POD_PRESETS;

export const POD_FALLBACK_NOTE =
  "Fallback estimate: Printful blank + US shipping from the business plan, converted to CHF. Not a Printify quote and not CH/EU shipping. Printify shop currency is assumed CHF.";

export function podCostChf(preset: PodPreset, rate = activeUsdToChf()) {
  const p = POD_PRESETS[preset];
  return round2(usdToChf(p.baseUsd + p.shippingUsd, rate));
}

export function productLabel(productType: "digital" | "pod", podProvider?: string | null) {
  if (productType === "digital") return "Digital download";
  const preset = podProvider?.split(":")[1] as PodPreset | undefined;
  return `POD · ${preset && POD_PRESETS[preset] ? POD_PRESETS[preset].label : "print"}`;
}
