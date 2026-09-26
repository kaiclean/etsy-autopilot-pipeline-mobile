import { describe, expect, it } from "vitest";
import { calculateFees, FEES, podCostChf, retailRound, suggestPrice, usdToChf } from "@/lib/fees";

describe("calculateFees: business plan §6 worked examples", () => {
  it("A. digital printable at CHF 8.00 nets CHF 6.37 (79.7%)", () => {
    const f = calculateFees({ priceChf: 8 });
    expect(f.listingFeeChf).toBe(0.17);
    expect(f.transactionFeeChf).toBe(0.52);
    expect(f.processingFeeChf).toBe(0.82);
    expect(f.vatOnFeesChf).toBe(0.12);
    expect(f.netChf).toBe(6.37);
    expect(f.marginPct).toBeCloseTo(79.66, 1);
  });

  it("A. with Offsite Ads attribution nets CHF 5.17", () => {
    const f = calculateFees({ priceChf: 8, offsiteAds: true });
    expect(f.offsiteAdsFeeChf).toBe(1.2);
    expect(f.netChf).toBe(5.17);
  });

  it("B. POD poster at CHF 29 with Printful A3 (USD 10.90 + 4.99) nets CHF 11.84", () => {
    const f = calculateFees({ priceChf: 29, podCostChf: usdToChf(10.9 + 4.99) });
    expect(f.podCostChf).toBe(13.15);
    expect(round(f.listingFeeChf + f.transactionFeeChf + f.processingFeeChf)).toBeCloseTo(3.71, 1);
    expect(f.vatOnFeesChf).toBe(0.3);
    expect(f.netChf).toBe(11.84);
    expect(f.marginPct).toBeCloseTo(40.8, 1);
  });

  it("B. with Offsite Ads nets CHF 7.49", () => {
    const f = calculateFees({ priceChf: 29, podCostChf: usdToChf(15.89), offsiteAds: true });
    expect(f.netChf).toBe(7.49);
  });

  it("uses the plan's constants", () => {
    expect(FEES).toMatchObject({
      usdToChf: 0.8278,
      listingFeeUsd: 0.2,
      transactionRate: 0.065,
      processingRate: 0.04,
      processingFixedChf: 0.5,
      vatOnFeesRate: 0.081,
      offsiteAdsRate: 0.15,
    });
  });

  it("charges transaction + processing on shipping too", () => {
    const withShip = calculateFees({ priceChf: 20, shippingChf: 5 });
    const noShip = calculateFees({ priceChf: 25 });
    expect(withShip.netChf).toBe(noShip.netChf);
  });

  it("scales per-unit costs with quantity but keeps the fixed processing fee once", () => {
    const one = calculateFees({ priceChf: 10 });
    const two = calculateFees({ priceChf: 10, quantity: 2 });
    expect(two.revenueChf).toBe(20);
    expect(two.processingFeeChf).toBe(round(20 * 0.04 + 0.5));
    expect(two.listingFeeChf).toBe(round(usdToChf(0.2) * 2));
    expect(one.listingFeeChf).toBe(0.17);
  });

  it("reports negative net when POD cost exceeds price", () => {
    const f = calculateFees({ priceChf: 10, podCostChf: 15 });
    expect(f.netChf).toBeLessThan(0);
  });
});

describe("suggestPrice", () => {
  it("returns a retail .90 price that meets the target margin", () => {
    for (const target of [40, 55, 70]) {
      const p = suggestPrice({ targetMarginPct: target });
      expect(Math.round(p * 100) % 100).toBe(90);
      expect(calculateFees({ priceChf: p }).marginPct).toBeGreaterThanOrEqual(target);
    }
  });

  it("accounts for POD cost and Offsite Ads", () => {
    const pod = podCostChf("posterA3");
    const p = suggestPrice({ targetMarginPct: 35, podCostChf: pod, offsiteAds: true });
    expect(calculateFees({ priceChf: p, podCostChf: pod, offsiteAds: true }).marginPct).toBeGreaterThanOrEqual(35);
  });

  it("respects min/max bounds", () => {
    expect(suggestPrice({ targetMarginPct: 10, minChf: 5.9 })).toBe(5.9);
    expect(suggestPrice({ targetMarginPct: 60, podCostChf: 30, maxChf: 49.9 })).toBe(49.9);
  });

  it("throws when the margin is unreachable", () => {
    expect(() => suggestPrice({ targetMarginPct: 95 })).toThrow();
  });

  it("retailRound rounds up to .90", () => {
    expect(retailRound(7.2)).toBe(7.9);
    expect(retailRound(7.9)).toBe(7.9);
    expect(retailRound(7.95)).toBe(8.9);
  });
});

function round(n: number) {
  return Math.round(n * 100) / 100;
}
