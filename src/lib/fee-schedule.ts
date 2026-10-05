/**
 * Etsy fee table for a Swiss seller who lists in CHF.
 * Rates are not remembered ad hoc: they are copied from the sources below and dated.
 * Check `feeScheduleStatus()` before trusting a margin. Do not scrape Etsy shop or search pages.
 */
export const FEE_SCHEDULE = {
  verifiedAt: "2026-10-05",
  staleAfterDays: 90,
  sources: [
    { name: "Etsy Fees & Payments Policy", url: "https://www.etsy.com/legal/fees" },
    { name: "Etsy seller fees and taxes (CH processing 4% + CHF 0.50)", url: "https://help.etsy.com/hc/en-us/articles/115015628847" },
    { name: "VAT on Etsy seller fees (Swiss 8.1%)", url: "https://help.etsy.com/hc/en-us/articles/360040584433" },
    { name: "Offsite Ads (15% / 12% over USD 10,000, cap USD 100)", url: "https://help.etsy.com/hc/en-us/articles/360000337827" },
  ],
  listingFeeUsd: 0.2,
  transactionRate: 0.065,
  processingRate: 0.04,
  processingFixedChf: 0.5,
  /** Swiss VAT on Etsy's own fees, including Offsite Ads. Not the VAT Etsy collects from the buyer. */
  vatOnFeesRate: 0.081,
  offsiteAdsRate: 0.15,
  offsiteAdsReducedRate: 0.12,
  /** Trailing 365-day sales above this USD amount use the reduced Offsite Ads rate. */
  offsiteAdsReducedAfterUsd: 10_000,
  offsiteAdsCapUsd: 100,
} as const;

/**
 * Reference FX from the business plan: ECB rate via frankfurter.app on 24 Sep 2026.
 * Not a live quote. Override with USD_TO_CHF, or let the analytics stage store a newer
 * rate when FX_REFRESH=true.
 */
export const REFERENCE_USD_TO_CHF = 0.8278;
export const REFERENCE_USD_TO_CHF_AS_OF = "2026-09-24";
export const REFERENCE_USD_TO_CHF_SOURCE = "https://www.frankfurter.app/2026-09-24?from=USD&to=CHF";

export const FRANKFURTER_LATEST = "https://api.frankfurter.app/latest?from=USD&to=CHF";

/**
 * Processing-fee base assumption for suggested prices.
 * Etsy charges processing on the tax-inclusive total when it collects destination VAT.
 * A listing does not know the buyer's country, so suggestions default to 0
 * (business plan §6, "buyer outside CH"). Set BUYER_TAX_RATE_ASSUMPTION=0.081 to
 * price as if every buyer were Swiss. Orders pass the tax actually on the receipt.
 */
export function assumedBuyerTaxRate() {
  const raw = process.env.BUYER_TAX_RATE_ASSUMPTION;
  if (raw == null || raw.trim() === "") return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n >= 1) return 0;
  return n;
}

export function resolveUsdToChf(opts?: { stored?: number; storedAsOf?: string }) {
  const envRate = Number(process.env.USD_TO_CHF);
  if (Number.isFinite(envRate) && envRate > 0) {
    return {
      rate: envRate,
      source: "USD_TO_CHF" as const,
      asOf: process.env.USD_TO_CHF_AS_OF?.trim() || "env",
    };
  }
  if (opts?.stored != null && Number.isFinite(opts.stored) && opts.stored > 0) {
    return { rate: opts.stored, source: "settings" as const, asOf: opts.storedAsOf ?? "settings" };
  }
  return {
    rate: REFERENCE_USD_TO_CHF,
    source: "reference" as const,
    asOf: REFERENCE_USD_TO_CHF_AS_OF,
  };
}

export function feeScheduleStatus(now = new Date()) {
  const verified = Date.parse(`${FEE_SCHEDULE.verifiedAt}T00:00:00Z`);
  const ageDays = Math.floor((now.getTime() - verified) / 86_400_000);
  const stale = ageDays > FEE_SCHEDULE.staleAfterDays;
  return {
    verifiedAt: FEE_SCHEDULE.verifiedAt,
    ageDays,
    stale,
    sources: FEE_SCHEDULE.sources,
    message: stale
      ? `Etsy fee rates were last verified ${FEE_SCHEDULE.verifiedAt} (${ageDays} days ago). Check the source links before trusting margins.`
      : null,
  };
}

export type FeeFxQuote = { usdToChf: number; asOf: string; source: string };

/** ECB reference via frankfurter.app. Returns null when the response is unusable. */
export async function fetchUsdToChf(fetchImpl: typeof fetch = fetch): Promise<FeeFxQuote | null> {
  const res = await fetchImpl(FRANKFURTER_LATEST, { headers: { accept: "application/json" } });
  if (!res.ok) return null;
  const json = (await res.json()) as { amount?: number; date?: string; rates?: { CHF?: number } };
  const rate = json.rates?.CHF;
  if (typeof rate !== "number" || !(rate > 0) || rate > 5) return null;
  return { usdToChf: rate, asOf: json.date ?? new Date().toISOString().slice(0, 10), source: FRANKFURTER_LATEST };
}
