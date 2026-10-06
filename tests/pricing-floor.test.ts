import { describe, expect, it } from "vitest";
import { pickPricedVariantIds, type VariantRow } from "@/adapters/printify/catalog";
import { mapReceipt } from "@/adapters/etsy/receipts";
import { FEE_SCHEDULE, feeScheduleStatus, resolveUsdToChf } from "@/lib/fee-schedule";
import {
  calculateFees,
  MARGIN_TARGETS,
  minimumRetailPrice,
  POD_PRESETS,
  podCostChf,
  priceFloorIssue,
  resolveTargetMargin,
  suggestPrice,
  type PodPreset,
} from "@/lib/fees";
import { quoteFromPrintify, pricesForVariantCosts, printifyOrderCostChf, fallbackPodQuote } from "@/lib/pod-cost";
import { NICHES } from "@/lib/niches";
import type { Niche } from "@/db/schema";

function shopPrice(preset: PodPreset, niche: Niche, offsiteAds: boolean) {
  const band = NICHES[niche].priceBand.pod;
  const cost = podCostChf(preset);
  return {
    cost,
    price: suggestPrice({
      targetMarginPct: resolveTargetMargin("pod", MARGIN_TARGETS.podDefault),
      podCostChf: cost,
      offsiteAds,
      minChf: band[0] || undefined,
      maxChf: band[1] || undefined,
      competitorChf: POD_PRESETS[preset].marketAnchorChf,
      productType: "pod",
    }),
  };
}

describe("POD margin floor", () => {
  it("keeps every preset at or above 25% with and without Offsite Ads", () => {
    const niches = { posterA3: "alpine", mug: "christmas", tshirt: "alpine", sweatshirt: "gothic" } as const;
    for (const preset of Object.keys(POD_PRESETS) as PodPreset[]) {
      for (const offsiteAds of [false, true]) {
        const { cost, price } = shopPrice(preset, niches[preset], offsiteAds);
        const fees = calculateFees({ priceChf: price, podCostChf: cost, offsiteAds });
        expect(fees.marginPct, `${preset} offsite=${offsiteAds} @ ${price}`).toBeGreaterThanOrEqual(MARGIN_TARGETS.podMin);
        expect(price).toBeGreaterThanOrEqual(minimumRetailPrice({ productType: "pod", podCostChf: cost, offsiteAds }));
      }
    }
  });

  it("blocks the audit examples that landed near 18%", () => {
    const poster = podCostChf("posterA3");
    const sweat = podCostChf("sweatshirt");
    expect(calculateFees({ priceChf: 24.9, podCostChf: poster, offsiteAds: true }).marginPct).toBeLessThan(25);
    expect(calculateFees({ priceChf: 36.9, podCostChf: sweat, offsiteAds: true }).marginPct).toBeLessThan(25);
    expect(priceFloorIssue({ priceChf: 24.9, productType: "pod", podCostChf: poster, offsiteAds: true })?.message).toMatch(/25%/);
    expect(priceFloorIssue({ priceChf: 36.9, productType: "pod", podCostChf: sweat, offsiteAds: true })?.code).toBe("price_below_margin_floor");
    expect(priceFloorIssue({ priceChf: 8, productType: "digital", offsiteAds: false })).toBeNull();
  });

  it("does not let the niche ceiling undercut the floor", () => {
    const cost = podCostChf("posterA3");
    const price = suggestPrice({
      targetMarginPct: 30,
      podCostChf: cost,
      offsiteAds: true,
      maxChf: 24.9,
      competitorChf: 24.9,
      productType: "pod",
    });
    expect(price).toBeGreaterThan(24.9);
    expect(calculateFees({ priceChf: price, podCostChf: cost, offsiteAds: true }).marginPct).toBeGreaterThanOrEqual(25);
  });

  it("blocks a digital price that does not cover fees", () => {
    const issue = priceFloorIssue({ priceChf: 0.5, productType: "digital", offsiteAds: true });
    expect(issue?.code).toBe("price_below_cost_floor");
    expect(issue?.message).toMatch(/cost plus fees/);
    const floor = minimumRetailPrice({ productType: "digital", offsiteAds: true });
    expect(calculateFees({ priceChf: floor, offsiteAds: true }).netChf).toBeGreaterThanOrEqual(0);
  });
});

describe("fee schedule", () => {
  it("is dated, sourced, and stale after 90 days", () => {
    expect(FEE_SCHEDULE.verifiedAt).toBe("2026-10-05");
    expect(FEE_SCHEDULE.sources.map((source) => source.url)).toEqual(
      expect.arrayContaining([expect.stringContaining("etsy.com/legal/fees"), expect.stringContaining("help.etsy.com")]),
    );
    expect(feeScheduleStatus(new Date("2026-10-05T00:00:00Z")).stale).toBe(false);
    expect(feeScheduleStatus(new Date("2027-01-15T00:00:00Z")).stale).toBe(true);
  });

  it("uses USD_TO_CHF instead of the reference rate when set", () => {
    const previous = process.env.USD_TO_CHF;
    process.env.USD_TO_CHF = "0.9";
    try {
      expect(resolveUsdToChf().rate).toBe(0.9);
      expect(calculateFees({ priceChf: 8 }).listingFeeChf).toBeCloseTo(0.18, 2);
    } finally {
      if (previous == null) delete process.env.USD_TO_CHF;
      else process.env.USD_TO_CHF = previous;
    }
  });

  it("caps Offsite Ads at USD 100 and drops to 12% after USD 10,000", () => {
    const capped = calculateFees({ priceChf: 2000, offsiteAds: true });
    expect(capped.offsiteAdsCapped).toBe(true);
    expect(capped.offsiteAdsFeeChf).toBeCloseTo(100 * 0.8278, 2);
    const reduced = calculateFees({ priceChf: 100, offsiteAds: true, trailingSalesUsd: 12_000 });
    expect(reduced.offsiteAdsRate).toBe(0.12);
    expect(reduced.offsiteAdsFeeChf).toBe(12);
    const full = calculateFees({ priceChf: 100, offsiteAds: true, trailingSalesUsd: 9_000 });
    expect(full.offsiteAdsFeeChf).toBe(15);
  });

  it("charges processing on the tax-inclusive total when buyer tax is known", () => {
    const plain = calculateFees({ priceChf: 100 });
    const taxed = calculateFees({ priceChf: 100, buyerTaxRate: 0.081 });
    expect(taxed.processingFeeChf).toBeGreaterThan(plain.processingFeeChf);
  });
});

describe("Printify cost quote", () => {
  const variants: VariantRow[] = [
    { id: 1, title: "White / S", cost: 1000, placeholders: [{ position: "front" }] },
    { id: 2, title: "White / M", cost: 1200, placeholders: [{ position: "front" }] },
    { id: 3, title: "White / XL", cost: 1800, placeholders: [{ position: "front" }] },
    { id: 4, title: "Black / M", cost: 1200, placeholders: [{ position: "front" }] },
  ];
  const shipping = [
    { variant_ids: [1, 2, 3, 4], countries: ["CH"], first_item: { cost: 500, currency: "CHF" } },
    { variant_ids: [1, 2, 3, 4], countries: ["US"], first_item: { cost: 400, currency: "USD" } },
  ];

  it("uses CH shipping and a separate price per variant", () => {
    const quote = quoteFromPrintify({
      preset: "tshirt",
      shopCurrency: null,
      blueprintId: 12,
      printProviderId: 34,
      variants,
      shippingProfiles: shipping,
      fxRate: 0.8278,
      priceOpts: { targetMarginPct: 30, offsiteAds: false },
    });
    expect(quote.source).toBe("printify");
    expect(quote.assumedShopCurrencyChf).toBe(true);
    expect(quote.note).toMatch(/assumed to be CHF/);
    expect(quote.note).toMatch(/CH/);
    expect(quote.variants.map((variant) => variant.id)).toEqual([1, 2, 3]);
    expect(quote.variants[0].shippingChf).toBe(5);
    expect(quote.variants[2].costChf).toBeGreaterThan(quote.variants[0].costChf);
    const prices = pricesForVariantCosts(
      quote.variants.map((variant) => ({ id: variant.id, costChf: variant.costChf })),
      { targetMarginPct: 30, offsiteAds: true },
    );
    expect(prices[2].priceChf).toBeGreaterThan(prices[0].priceChf);
    expect(calculateFees({ priceChf: prices[0].priceChf, podCostChf: prices[2].costChf, offsiteAds: true }).marginPct).toBeLessThan(25);
    expect(calculateFees({ priceChf: prices[2].priceChf, podCostChf: prices[2].costChf, offsiteAds: true }).marginPct).toBeGreaterThanOrEqual(25);
  });

  it("falls back when the shop currency cannot be converted and labels the estimate", () => {
    const quote = quoteFromPrintify({
      preset: "mug",
      shopCurrency: "EUR",
      blueprintId: 1,
      printProviderId: 2,
      variants: [{ id: 9, title: "11oz", cost: 590 }],
      shippingProfiles: shipping,
      fxRate: 0.8278,
      priceOpts: { targetMarginPct: 30 },
    });
    expect(quote.source).toBe("fallback");
    expect(quote.note).toMatch(/Printful/);
    expect(quote.note).toMatch(/EUR/);
    expect(fallbackPodQuote("posterA3").note).toMatch(/assumed CHF/);
  });

  it("prefers EU shipping when CH is missing", () => {
    const quote = quoteFromPrintify({
      preset: "posterA3",
      shopCurrency: "CHF",
      blueprintId: 5,
      printProviderId: 6,
      variants: [{ id: 7, title: "A3", cost: 1090, placeholders: [{ position: "front" }] }],
      shippingProfiles: [{ variant_ids: [7], countries: ["DE", "FR"], first_item: { cost: 450, currency: "CHF" } }],
      fxRate: 0.8278,
      priceOpts: { targetMarginPct: 30 },
    });
    expect(quote.source).toBe("printify");
    expect(quote.variants[0].shippingDestination).toBe("EU");
    expect(quote.assumedShopCurrencyChf).toBe(false);
    expect(quote.note).toMatch(/currency is CHF/);
  });

  it("reads Printify order cost in cents and flags a missing currency", () => {
    const cost = printifyOrderCostChf({ line_items: [{ cost: 1050, shipping_cost: 400, quantity: 1 }] }, 0.8278);
    expect(cost).toEqual({ costChf: 14.5, assumedChf: true, currency: null });
    expect(printifyOrderCostChf({ currency: "USD", line_items: [{ cost: 1000, shipping_cost: 0, quantity: 1 }] }, 0.8278)?.costChf).toBeCloseTo(8.28, 2);
    expect(printifyOrderCostChf({ status: "fulfilled" }, 0.8278)).toBeNull();
  });

  it("enables each adult apparel size instead of only medium", () => {
    expect(pickPricedVariantIds("tshirt", variants)).toEqual([1, 2, 3]);
    expect(pickPricedVariantIds("posterA3", [{ id: 8, title: "A3", placeholders: [{ position: "front" }] }])).toEqual([8]);
  });
});

describe("receipt pagination mapping", () => {
  it("keeps shipping, tax, discounts and refunds from a paid receipt", () => {
    const lines = mapReceipt({
      receipt_id: 50,
      status: "Canceled",
      country_iso: "CH",
      created_timestamp: 1_700_000_000,
      total_shipping_cost: { amount: 500, divisor: 100 },
      discount_amt: { amount: 100, divisor: 100 },
      total_tax_cost: { amount: 810, divisor: 100 },
      refunds: [{ amount: { amount: 2000, divisor: 100 } }],
      transactions: [{ transaction_id: 7, listing_id: 99, quantity: 2, price: { amount: 2490, divisor: 100 } }],
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      receiptId: "50-7",
      etsyReceiptId: "50",
      etsyListingId: "99",
      quantity: 2,
      totalChf: 49.8,
      shippingChf: 5,
      discountChf: 1,
      taxChf: 8.1,
      refundChf: 20,
      cancelled: true,
    });
  });
});
