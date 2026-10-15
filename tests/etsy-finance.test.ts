import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { etsyFinancialEvidence } from "@/db/etsy-finance";
import { getFinancialEvidence, importFinancialEvidence, parseFinanceImport } from "@/lib/etsy-finance";
import { recommendationsAreReviewable, RECOMMENDATION_FRESHNESS_MS } from "@/lib/operator-recommendations";
import { buildHealthReport, suggestListingActions } from "@/pipeline/health-report";

const now = new Date("2026-10-15T12:00:00Z");
const observation = {
  observationRef: "entry-1", etsyListingId: "10001", receiptId: "90001", ledgerType: "Brand new fee (42)",
  component: "unknown", status: "actual", amount: "-12345" as string | null, divisor: 1000, currency: "EUR",
  occurredAt: "2026-10-14T12:00:00Z",
};
function batch(overrides: Record<string, unknown> = {}, observations = [observation]) {
  return { etsyShopId: "111", authorizedSellerData: true, sourceKind: "seller_export", sourceRef: "ledger-a", observations, ...overrides };
}

describe("shop-owned immutable financial evidence", () => {
  const client = new PGlite("memory://");
  let db: DB;
  let shopId: string;
  let otherShopId: string;
  let listingId: number;

  beforeAll(async () => {
    db = drizzle(client, { schema }) as DB;
    await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
    const [shop] = await db.insert(schema.shops).values({ slug: "finance-a", displayName: "Finance A", etsyShopId: "111" }).returning();
    const [other] = await db.insert(schema.shops).values({ slug: "finance-b", displayName: "Finance B", etsyShopId: "222" }).returning();
    shopId = shop.id;
    otherShopId = other.id;
    const base = {
      niche: "alpine" as const, productType: "digital" as const, title: "Finance fixture", tags: ["poster"],
      description: "Fixture", imageUrl: "/fixture.png", priceChf: 20, netChf: 10, marginPct: 50,
      status: "published" as const, publishMode: "live" as const, publishedAt: new Date("2026-09-01T00:00:00Z"),
      views: 20, favorites: 0, analyticsCheckedAt: now,
    };
    const [listing] = await db.insert(schema.listings).values({ ...base, shopId, etsyListingId: "10001" }).returning();
    listingId = listing.id;
    await db.insert(schema.listings).values({ ...base, shopId: otherShopId, etsyListingId: "10002", views: 999 });
    await db.insert(schema.listings).values([
      { ...base, shopId, etsyListingId: "10003", status: "approved", views: 0, analyticsCheckedAt: null },
      { ...base, shopId, etsyListingId: "10004", isDemo: true },
      { ...base, shopId, etsyListingId: "10005", publishMode: "dry-run" },
    ]);
    await db.insert(schema.orders).values({
      shopId, listingId, etsyReceiptId: "90001", buyerCountry: "CH", totalChf: 20,
      feesChf: 5, profitChf: 15, fulfillmentStatus: "delivered_digital", createdAt: now,
    });
    await db.insert(schema.orders).values({
      shopId: otherShopId, etsyReceiptId: "90002", buyerCountry: "CH", totalChf: 999,
      feesChf: 1, profitChf: 998, fulfillmentStatus: "delivered_digital", createdAt: now,
    });
  }, 30_000);
  afterAll(async () => { await client.close(); });

  it("retains unknown ledger types, original currency/divisor and source references without changing estimates", async () => {
    const result = await importFinancialEvidence(db, shopId, batch());
    expect(result.profitStatus).toBe("unavailable");
    const evidence = await getFinancialEvidence(db, shopId);
    expect(evidence.rows).toHaveLength(1);
    expect(evidence.rows[0]).toMatchObject({
      amount: "-12345", divisor: 1000, currency: "EUR", component: "unknown",
      ledgerType: "Brand new fee (42)", sourceRef: "ledger-a", observationRef: "entry-1", status: "actual",
      listingId,
    });
    expect(evidence.incompleteComponents).toContain("supplier production and shipping");
    const [order] = await db.select().from(schema.orders).where(eq(schema.orders.etsyReceiptId, "90001"));
    expect(order).toMatchObject({ feesChf: 5, profitChf: 15, totalChf: 20 });
  });

  it("is idempotent on replay and repeated rows within a batch", async () => {
    await importFinancialEvidence(db, shopId, batch({}, [observation, observation]));
    await Promise.all([
      importFinancialEvidence(db, shopId, batch()),
      importFinancialEvidence(db, shopId, batch()),
    ]);
    const rows = await db.select().from(etsyFinancialEvidence).where(and(eq(etsyFinancialEvidence.shopId, shopId), eq(etsyFinancialEvidence.sourceRef, "ledger-a")));
    expect(rows).toHaveLength(1);
  });

  it("rejects changed replay atomically without losing original evidence or inserting companion rows", async () => {
    await expect(importFinancialEvidence(db, shopId, batch({}, [
      { ...observation, amount: "-777" },
      { ...observation, observationRef: "must-not-insert" },
    ]))).rejects.toMatchObject({ status: 409 });
    const rows = await db.select().from(etsyFinancialEvidence).where(eq(etsyFinancialEvidence.shopId, shopId));
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe("-12345");
  });

  it("rejects cross-shop exports, substring listing matches, foreign listings and receipts before writes", async () => {
    await expect(importFinancialEvidence(db, otherShopId, batch())).rejects.toMatchObject({ status: 403 });
    for (const overrides of [
      { etsyListingId: "10002" }, { etsyListingId: "1000" }, { receiptId: "90002" },
      { etsyListingId: "10003" }, { etsyListingId: "10004" }, { etsyListingId: "10005" },
    ]) {
      await expect(importFinancialEvidence(db, shopId, batch({ sourceRef: "rejected" }, [{ ...observation, ...overrides }]))).rejects.toMatchObject({ status: 403 });
    }
    expect((await getFinancialEvidence(db, otherShopId)).rows).toHaveLength(0);
  });

  it("supports unavailable and estimated observations without inferring actual profit or zero cost", async () => {
    await importFinancialEvidence(db, shopId, batch({ sourceRef: "coverage" }, [
      { ...observation, observationRef: "missing-supplier", component: "supplier_spend", status: "unavailable", amount: null },
      { ...observation, observationRef: "estimated-fee", component: "fee", status: "estimated", currency: "CHF", amount: "-100" },
      { ...observation, observationRef: "refund", component: "refund", amount: "-200", currency: "USD" },
    ]));
    const evidence = await getFinancialEvidence(db, shopId);
    expect(evidence.profitStatus).toBe("unavailable");
    expect(evidence.rows.find((row) => row.observationRef === "missing-supplier")?.amount).toBeNull();
    expect(evidence.rows.find((row) => row.observationRef === "estimated-fee")?.status).toBe("estimated");
  });

  it("preserves exact amounts beyond JavaScript integer precision for normalized observations", async () => {
    const amount = "-123456789012345678901234567890";
    await importFinancialEvidence(db, shopId, batch({ sourceKind: "normalized_ledger", sourceRef: "normalized-a" }, [
      { ...observation, amount, divisor: 1, currency: "JPY" },
    ]));
    const row = (await getFinancialEvidence(db, shopId)).rows.find((row) => row.sourceRef === "normalized-a");
    expect(row).toMatchObject({ sourceKind: "normalized_ledger", amount, divisor: 1, currency: "JPY" });
  });

  it("scopes health snapshots and sales to the selected shop, suppressing unknown and stale analytics", async () => {
    const report = await buildHealthReport(db, shopId, now);
    expect(report.views).toBe(20);
    expect(report.sales).toBe(1);
    expect(report.recommendationEvidence.freshListings).toBe(1);
    const other = await buildHealthReport(db, otherShopId, now);
    expect(other.suggestions).toHaveLength(1);
    expect(other.suggestions[0].reason).toContain("Human review required");
    expect(other.suggestions[0].reason).toContain("not period conversion");
    expect(recommendationsAreReviewable(other, now)).toBe(true);
    expect(recommendationsAreReviewable(other, new Date(now.getTime() + RECOMMENDATION_FRESHNESS_MS + 1))).toBe(false);
    await db.update(schema.listings).set({ analyticsCheckedAt: null }).where(eq(schema.listings.shopId, otherShopId));
    expect((await buildHealthReport(db, otherShopId, now)).suggestions).toHaveLength(0);
    await db.update(schema.listings).set({ analyticsCheckedAt: new Date(now.getTime() - RECOMMENDATION_FRESHNESS_MS - 1) }).where(eq(schema.listings.shopId, otherShopId));
    expect((await buildHealthReport(db, otherShopId, now)).suggestions).toHaveLength(0);
  });

  it("excludes canceled and refund-pending amounts from health totals without deleting audit records", async () => {
    await db.insert(schema.orders).values([
      {
        shopId, listingId, etsyReceiptId: "90003", buyerCountry: "CH", totalChf: 1000,
        feesChf: 100, profitChf: 900, podCostChf: 500, etsyPaymentStatus: "canceled",
        fulfillmentStatus: "delivered_digital", createdAt: now,
      },
      {
        shopId, listingId, etsyReceiptId: "90004", buyerCountry: "CH", totalChf: 2000,
        feesChf: 200, profitChf: 1800, podCostChf: 600, etsyPaymentStatus: "refund_pending",
        fulfillmentStatus: "delivered_digital", createdAt: now,
      },
    ]);
    const report = await buildHealthReport(db, shopId, now);
    expect(report.sales).toBe(1);
    expect(report.profitChf).toBe(15);
    expect(report.podCostChf).toBe(0);
    expect(report.suggestions.find((row) => row.listingId === listingId)).toBeUndefined();
    const auditRows = await db.select().from(schema.orders).where(eq(schema.orders.shopId, shopId));
    expect(auditRows).toHaveLength(3);
    expect(auditRows.find((row) => row.etsyReceiptId === "90004")).toMatchObject({
      etsyPaymentStatus: "refund_pending", totalChf: 2000, feesChf: 200, profitChf: 1800,
    });
  });

  it("matches compound live receipt-line keys exactly and idempotently without inferring whole-receipt ownership", async () => {
    const base = {
      shopId, listingId, buyerCountry: "CH", totalChf: 10, feesChf: 1, profitChf: 9,
      fulfillmentStatus: "delivered_digital" as const, createdAt: now,
    };
    await db.insert(schema.orders).values([
      { ...base, etsyReceiptId: "90005-10005" },
      { ...base, etsyReceiptId: "90005-10006" },
      { ...base, shopId: otherShopId, listingId: null, etsyReceiptId: "90006-10007" },
    ]);
    const input = batch({ sourceRef: "compound-lines" }, [{ ...observation, receiptId: "90005-10005" }]);
    await importFinancialEvidence(db, shopId, input);
    await importFinancialEvidence(db, shopId, input);
    const imported = (await getFinancialEvidence(db, shopId)).rows.filter((row) => row.sourceRef === "compound-lines");
    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatchObject({ receiptId: "90005-10005", listingId });
    for (const receiptId of ["90005", "90005-1000", "90006-10007"]) {
      await expect(importFinancialEvidence(db, shopId, batch({ sourceRef: "unowned-compound" }, [
        { ...observation, receiptId },
      ]))).rejects.toMatchObject({ status: 403 });
    }
    await expect(importFinancialEvidence(db, shopId, batch({ sourceRef: "wrong-line-listing" }, [
      { ...observation, receiptId: "90005-10005", etsyListingId: "10003" },
    ]))).rejects.toMatchObject({ status: 403 });
    expect((await getFinancialEvidence(db, shopId)).rows.some((row) => row.sourceRef === "unowned-compound")).toBe(false);
  });
});

describe("financial import validation and deterministic recommendation evidence", () => {
  it("rejects unapproved sources, PII payload fields and invalid money", () => {
    for (const input of [
      batch({ authorizedSellerData: false }), batch({ sourceKind: "unverified_api" }),
      batch({ buyerEmail: "buyer@example.invalid" }),
      batch({}, [{ ...observation, amount: "12.34" }]),
      batch({}, [{ ...observation, divisor: 0 }]),
      batch({}, [{ ...observation, status: "unavailable", amount: "0" }]),
      batch({}, [{ ...observation, ledgerType: "Fee for buyer@example.invalid" }]),
      batch({}, [{ ...observation, receiptId: "90005-" }]),
      batch({}, [{ ...observation, receiptId: "90005-10005-extra" }]),
    ]) expect(() => parseFinanceImport(input)).toThrow();
  });

  it("preserves unfamiliar open-string ledger categories exactly instead of enforcing a known category whitelist", () => {
    const ledgerType = " Unmapped fee / 海外 + v2?! ";
    expect(parseFinanceImport(batch({}, [{ ...observation, ledgerType }])).observations[0].ledgerType).toBe(ledgerType);
  });

  it("requires finite fresh non-future snapshots, with a deterministic 36h boundary", () => {
    const base = { id: 1, title: "Review candidate", views: 20, favorites: 0, sales: 0, ageDays: 30 };
    const atBoundary = new Date(now.getTime() - RECOMMENDATION_FRESHNESS_MS);
    expect(suggestListingActions([{ ...base, analyticsCheckedAt: atBoundary }], now)).toHaveLength(1);
    for (const analyticsCheckedAt of [undefined, null, new Date(NaN), new Date(now.getTime() + 1), new Date(atBoundary.getTime() - 1)]) {
      expect(suggestListingActions([{ ...base, analyticsCheckedAt }], now)).toHaveLength(0);
    }
  });
});
