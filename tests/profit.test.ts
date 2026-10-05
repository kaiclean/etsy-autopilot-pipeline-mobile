import { describe, expect, it } from "vitest";
import { adsEstimateNote, adsNoteDate, missingAdsDays } from "@/lib/ads-budget";
import { operatingCostTotal, quoteOrderEconomics } from "@/lib/economics";
import { calculateFees } from "@/lib/fees";
import { normalizeLedgerEntry, summarizeLedger } from "@/lib/ledger";
import { collectPages } from "@/lib/pagination";

describe("order profit", () => {
  it("counts Offsite Ads in live mode from the shop assumption and labels the result estimated", () => {
    const quote = quoteOrderEconomics({
      mode: "live",
      assumeOffsiteAds: true,
      quantity: 1,
      itemChf: 29,
      podCostChf: 13.15,
      podCostFromOrder: false,
      ledger: null,
    });
    expect(quote.offsiteAdsChf).toBeGreaterThan(0);
    expect(quote.basis).toBe("estimated");
    expect(quote.profitChf).toBe(calculateFees({ priceChf: 29, podCostChf: 13.15, offsiteAds: true }).netChf);
  });

  it("does not invent an Offsite Ads fee in live mode when the shop assumption is off", () => {
    const quote = quoteOrderEconomics({
      mode: "live",
      assumeOffsiteAds: false,
      quantity: 1,
      itemChf: 29,
      podCostChf: 13.15,
      podCostFromOrder: false,
      ledger: null,
    });
    expect(quote.offsiteAdsChf).toBe(0);
    expect(quote.basis).toBe("estimated");
  });

  it("zeros a cancelled order instead of keeping the sale profit", () => {
    const quote = quoteOrderEconomics({
      mode: "live",
      assumeOffsiteAds: true,
      quantity: 1,
      itemChf: 29,
      refundChf: 29,
      cancelled: true,
      podCostChf: 13.15,
      podCostFromOrder: false,
      ledger: null,
    });
    expect(quote.profitChf).toBe(0);
    expect(quote.totalChf).toBe(0);
    expect(quote.refundedChf).toBe(29);
    expect(quote.cancelled).toBe(true);
  });

  it("reconciles fees from the ledger and POD cost from the Printify order", () => {
    const estimated = quoteOrderEconomics({
      mode: "live",
      assumeOffsiteAds: false,
      quantity: 1,
      itemChf: 40,
      shippingChf: 5,
      podCostChf: 20,
      podCostFromOrder: false,
      ledger: null,
    });
    const reconciled = quoteOrderEconomics({
      mode: "live",
      assumeOffsiteAds: false,
      quantity: 1,
      itemChf: 40,
      shippingChf: 5,
      podCostChf: 14.5,
      podCostFromOrder: true,
      ledger: {
        referenceId: "50",
        paymentChf: 45,
        feeChf: 9.5,
        offsiteAdsChf: 6.75,
        refundChf: 0,
        listingFeeChf: 0.2,
        netBeforePodChf: 35.5,
        entryCount: 4,
        assumedChf: false,
      },
    });
    expect(reconciled.basis).toBe("reconciled");
    expect(reconciled.offsiteAdsChf).toBe(6.75);
    expect(reconciled.profitChf).toBe(21);
    expect(reconciled.profitChf).not.toBe(estimated.profitChf);
  });

  it("stays estimated when the ledger is present but POD cost is still the fallback", () => {
    const quote = quoteOrderEconomics({
      mode: "live",
      assumeOffsiteAds: false,
      quantity: 1,
      itemChf: 40,
      podCostChf: 20,
      podCostFromOrder: false,
      ledger: {
        referenceId: "50",
        paymentChf: 40,
        feeChf: 8,
        offsiteAdsChf: 0,
        refundChf: 0,
        listingFeeChf: 0.2,
        netBeforePodChf: 32,
        entryCount: 2,
        assumedChf: false,
      },
    });
    expect(quote.basis).toBe("estimated");
    expect(quote.feesChf).toBe(8);
    expect(quote.profitChf).toBe(12);
  });

  it("includes listing and renewal fees in operating costs", () => {
    expect(operatingCostTotal({ ai_image: 1, ai_text: 0.2, ads: 0.83, listing_fee: 0.18, other: 0 })).toBeCloseTo(2.21, 2);
  });
});

describe("ledger entries", () => {
  it("groups Offsite Ads, refunds and shop renewals", () => {
    const entries = [
      { entry_id: 1, amount: 4000, currency: "CHF", ledger_type: "PAYMENT", reference_id: "50", reference_type: "receipt" },
      { entry_id: 2, amount: -675, currency: "CHF", ledger_type: "offsite_ads_fee", reference_id: "50", reference_type: "receipt" },
      { entry_id: 3, amount: -55, currency: "CHF", ledger_type: "vat_seller_services", reference_id: "50", reference_type: "receipt" },
      { entry_id: 4, amount: -2000, currency: "CHF", ledger_type: "REFUND", reference_id: "50", reference_type: "receipt" },
      { entry_id: 5, amount: -20, currency: "CHF", ledger_type: "auto_renew_expired", reference_id: null, reference_type: "shop" },
      { entry_id: 6, amount: -1000, currency: "CHF", ledger_type: "DISBURSE2", reference_id: "payout", reference_type: "shop" },
    ].map((row) => normalizeLedgerEntry(row, 0.8278)!);
    const { byReceipt, shopRenewals } = summarizeLedger(entries);
    const receipt = byReceipt.get("50")!;
    expect(receipt.offsiteAdsChf).toBe(6.75);
    expect(receipt.refundChf).toBe(20);
    expect(receipt.paymentChf).toBe(40);
    expect(receipt.feeChf).toBeCloseTo(27.3, 2);
    expect(shopRenewals).toEqual([{ entryId: "5", amountChf: 0.2, ledgerType: "auto_renew_expired", assumedChf: false }]);
    expect(byReceipt.has("payout")).toBe(false);
  });
});

describe("ads cap estimate", () => {
  it("labels the daily cap as an estimate and fills missed days after ads were enabled", () => {
    expect(adsEstimateNote("2026-10-05")).toMatch(/estimate/);
    expect(adsNoteDate("Etsy Ads budget 2026-10-01")).toBe("2026-10-01");
    expect(adsNoteDate(adsEstimateNote("2026-10-03"))).toBe("2026-10-03");
    const missing = missingAdsDays({
      today: "2026-10-05",
      enabledAt: "2026-10-02T08:00:00Z",
      existingNotes: [adsEstimateNote("2026-10-03"), "Etsy Ads budget 2026-10-02"],
    });
    expect(missing).toEqual(["2026-10-04", "2026-10-05"]);
  });

  it("does not invent days before the first booking when the enable time is unknown", () => {
    expect(
      missingAdsDays({
        today: "2026-10-05",
        enabledAt: null,
        existingNotes: ["Etsy Ads budget 2026-10-04 (demo)"],
      }),
    ).toEqual(["2026-10-05"]);
  });
});

describe("collectPages", () => {
  it("reads past the first 100 rows and stops on a short page", async () => {
    const calls: number[] = [];
    const rows = await collectPages(async (offset) => {
      calls.push(offset);
      return Array.from({ length: offset === 200 ? 50 : 100 }, (_, i) => offset + i);
    });
    expect(calls).toEqual([0, 100, 200]);
    expect(rows).toHaveLength(250);
  });
});
