import { calculateFees, round2 } from "@/lib/fees";
import type { LedgerReceiptSummary } from "@/lib/ledger";

export type ProfitBasis = "estimated" | "reconciled";

export type OrderEconomics = {
  totalChf: number;
  feesChf: number;
  podCostChf: number;
  offsiteAdsChf: number;
  refundedChf: number;
  profitChf: number;
  basis: ProfitBasis;
  cancelled: boolean;
};

/**
 * Profit for one receipt line.
 * Live mode does not zero the Offsite Ads fee: it uses the ledger when the receipt is there,
 * and otherwise the shop's assumeOffsiteAds setting. That path is labelled estimated.
 * Reconciled means the Etsy ledger covered the receipt and the POD cost came from the Printify order
 * (or the line is digital).
 */
export function quoteOrderEconomics(input: {
  mode: "dry-run" | "live";
  assumeOffsiteAds: boolean;
  dryRunOffsite?: boolean;
  quantity: number;
  itemChf: number;
  shippingChf?: number;
  discountChf?: number;
  taxChf?: number;
  refundChf?: number;
  cancelled?: boolean;
  podCostChf: number;
  podCostFromOrder: boolean;
  ledger: LedgerReceiptSummary | null;
  buyerCountry?: string;
  usdToChf?: number;
  trailingSalesUsd?: number;
}): OrderEconomics {
  const item = input.itemChf;
  const shipping = input.shippingChf ?? 0;
  const discount = input.discountChf ?? 0;
  const tax = input.taxChf ?? 0;
  const refund = Math.max(0, input.refundChf ?? 0);
  const gross = round2(Math.max(0, item + shipping - discount));
  const cancelled = Boolean(input.cancelled) || (gross > 0 && refund >= gross - 0.009);

  if (input.ledger && input.ledger.entryCount > 0) {
    const pod = input.podCostChf;
    const profit = round2(input.ledger.netBeforePodChf - pod);
    const revenue = input.ledger.paymentChf > 0 ? input.ledger.paymentChf : round2(Math.max(0, gross - refund));
    return {
      totalChf: revenue,
      feesChf: input.ledger.feeChf,
      podCostChf: round2(pod),
      offsiteAdsChf: input.ledger.offsiteAdsChf,
      refundedChf: input.ledger.refundChf || (cancelled ? gross : refund),
      profitChf: profit,
      basis: input.podCostFromOrder || pod === 0 ? "reconciled" : "estimated",
      cancelled,
    };
  }

  if (cancelled) {
    return {
      totalChf: 0,
      feesChf: 0,
      podCostChf: 0,
      offsiteAdsChf: 0,
      refundedChf: refund || gross,
      profitChf: 0,
      basis: "estimated",
      cancelled: true,
    };
  }

  const netRevenue = round2(Math.max(0, gross - refund));
  const offsite = input.mode === "dry-run" ? Boolean(input.dryRunOffsite) : input.assumeOffsiteAds;
  const buyerTaxRate = netRevenue > 0 && tax > 0 ? tax / netRevenue : input.buyerCountry === "CH" ? 0.081 : 0;
  const unit = input.quantity > 0 ? netRevenue / input.quantity : netRevenue;
  const fees = calculateFees({
    priceChf: unit,
    quantity: input.quantity > 0 ? input.quantity : 1,
    podCostChf: input.podCostChf,
    offsiteAds: offsite,
    buyerTaxRate,
    usdToChf: input.usdToChf,
    trailingSalesUsd: input.trailingSalesUsd,
  });
  return {
    totalChf: fees.revenueChf,
    feesChf: fees.totalEtsyFeesChf,
    podCostChf: fees.podCostChf,
    offsiteAdsChf: fees.offsiteAdsFeeChf,
    refundedChf: refund,
    profitChf: fees.netChf,
    basis: "estimated",
    cancelled: false,
  };
}

export type CostKinds = { ai_image: number; ai_text: number; ads: number; listing_fee: number; other: number };

/** Publish-time listing fees and later renewals are operating costs. Ads rows are budget-cap estimates unless noted otherwise. */
export function operatingCostTotal(costs: CostKinds) {
  return costs.ai_image + costs.ai_text + costs.ads + costs.listing_fee + costs.other;
}
