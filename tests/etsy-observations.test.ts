import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getDb, type DB } from "@/db";
import { events, listings, orders, saleAlerts, shops, type Listing } from "@/db/schema";
import { etsyReceiptSnapshots } from "@/db/etsy-sync";
import type { EtsyListingStats, EtsyReceipt } from "@/adapters/etsy/types";
import { saveReceipts } from "@/pipeline/orders";
import { runAnalytics } from "@/pipeline/analytics";
import { analyticsOrdersWhere } from "@/lib/real-orders";

const state = vi.hoisted(() => ({ stats: {} as Record<string, EtsyListingStats> }));
vi.mock("@/adapters/etsy", () => ({
  getEtsyAdapter: async () => ({ mode: "live", getListingStats: async () => state.stats }),
}));
let db: DB;
let shopId: string;
let listing: Listing;
const now = new Date("2026-10-15T18:00:00Z");
beforeAll(async () => {
  db = await getDb();
  const [shop] = await db.insert(shops).values({ slug: "observations-test", displayName: "Observations" }).returning();
  shopId = shop.id;
  [listing] = await db.insert(listings).values({
    shopId, niche: "alpine", productType: "digital", title: "Alpine print", tags: ["alpine"],
    description: "Print", imageUrl: "/api/preview?src=test", priceChf: 10, netChf: 7, marginPct: 70,
    status: "published", etsyListingId: "456", publishMode: "live", isDemo: false,
    views: 120, favorites: 8, analyticsCheckedAt: now,
  }).returning();
}, 60_000);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function line(extra: Partial<EtsyReceipt> = {}): EtsyReceipt {
  return {
    receiptId: "123456-789", etsyListingId: "456", buyerCountry: "CH", quantity: 1, totalChf: 10,
    paid: true, canceled: false, createdAt: new Date("2026-10-01T00:00:00Z"), modifiedAt: now,
    originalMoney: { amount: 1000, divisor: 100, currency_code: "CHF" }, fxRate: 1, ...extra,
  };
}
const save = (rows: EtsyReceipt[]) => saveReceipts(db, rows, new Map([[listing.etsyListingId!, listing]]), {
  shopId, isDemo: false, offsite: () => false,
});

describe("redacted receipt observations", () => {
  it("records later cancellation/refunds once without erasing the original financial estimate", async () => {
    expect((await save([line()])).inserted).toBe(1);
    const [before] = await db.select().from(orders).where(eq(orders.etsyReceiptId, "123456-789"));
    expect((await save([line({ canceled: true, modifiedAt: new Date(now.getTime() + 60_000) })])).inserted).toBe(0);
    const [after] = await db.select().from(orders).where(eq(orders.etsyReceiptId, "123456-789"));
    expect(after.totalChf).toBe(before.totalChf);
    expect(after.profitChf).toBe(before.profitChf);
    expect(after.etsyPaymentStatus).toBe("canceled");
    expect(await db.select().from(orders).where(analyticsOrdersWhere(shopId, new Date("2026-10-01")))).toEqual([]);
    await save([line({ refunded: true, modifiedAt: new Date(now.getTime() + 120_000) })]);
    const [snapshot] = await db.select().from(etsyReceiptSnapshots).where(eq(etsyReceiptSnapshots.receiptLineId, "123456-789"));
    expect(snapshot.refundDetected).toBe(true);
    expect(snapshot.originalMoney).toEqual({ amount: 1000, divisor: 100, currency_code: "CHF" });
    expect(snapshot).not.toHaveProperty("buyerEmail");
  });

  it("ignores stale observations and never promotes an unpaid receipt into revenue", async () => {
    const [before] = await db.select().from(etsyReceiptSnapshots).where(eq(etsyReceiptSnapshots.receiptLineId, "123456-789"));
    await save([line({ modifiedAt: new Date(now.getTime() - 60_000) })]);
    const [after] = await db.select().from(etsyReceiptSnapshots).where(eq(etsyReceiptSnapshots.receiptLineId, "123456-789"));
    expect(after).toEqual(before);
    const [unchanged] = await db.select().from(orders).where(eq(orders.etsyReceiptId, "123456-789"));
    expect(unchanged.etsyPaymentStatus).toBe("refund_pending");
    expect((await save([line({ receiptId: "123456-790", paid: false })])).inserted).toBe(0);
    expect(await db.select().from(orders).where(eq(orders.etsyReceiptId, "123456-790"))).toHaveLength(0);
  });

  it("rejects a listing from another shop before writing a receipt", async () => {
    await expect(saveReceipts(db, [line()], new Map([["456", listing]]), {
      shopId: "00000000-0000-0000-0000-000000000001", isDemo: false, offsite: () => false,
    })).rejects.toThrow("does not belong");
  });

  it.each(["canceled", "refunded"] as const)("does not insert an older paid receipt after a concurrent %s during sourcing", async (flag) => {
    const receiptId = flag === "canceled" ? "223456-101" : "223456-102";
    let started!: () => void;
    let resume!: () => void;
    const sourcingStarted = new Promise<void>((resolve) => { started = resolve; });
    const sourcingResumed = new Promise<void>((resolve) => { resume = resolve; });
    const beforeEvents = await db.select().from(events).where(eq(events.shopId, shopId));
    const older = saveReceipts(db, [line({ receiptId })], new Map([["456", listing]]), {
      shopId, isDemo: false, offsite: () => false,
      sourcingRecheck: async () => {
        started();
        await sourcingResumed;
        return null;
      },
    });
    try {
      await sourcingStarted;
      expect(await db.select().from(etsyReceiptSnapshots).where(eq(etsyReceiptSnapshots.receiptLineId, receiptId))).toHaveLength(0);
      expect(await save([line({ receiptId, [flag]: true, modifiedAt: new Date(now.getTime() + 60_000) })])).toEqual({ inserted: 0, unmatched: 0 });
    } finally {
      resume();
    }
    expect(await older).toEqual({ inserted: 0, unmatched: 0 });
    expect(await db.select().from(orders).where(eq(orders.etsyReceiptId, receiptId))).toHaveLength(0);
    const [snapshot] = await db.select().from(etsyReceiptSnapshots).where(eq(etsyReceiptSnapshots.receiptLineId, receiptId));
    expect(flag === "canceled" ? snapshot.canceled : snapshot.refundDetected).toBe(true);
    expect(await db.select().from(saleAlerts).where(eq(saleAlerts.etsyReceiptId, receiptId))).toHaveLength(0);
    expect(await db.select().from(events).where(eq(events.shopId, shopId))).toHaveLength(beforeEvents.length);
  });

  it.each(["canceled", "refunded"] as const)("keeps %s conservative at equal provider timestamps but accepts a truly newer paid state", async (flag) => {
    const receiptId = flag === "canceled" ? "223456-201" : "223456-202";
    expect((await save([line({ receiptId })])).inserted).toBe(1);
    await save([line({ receiptId, [flag]: true })]);
    await save([line({ receiptId })]);
    const [blocked] = await db.select().from(orders).where(eq(orders.etsyReceiptId, receiptId));
    expect(blocked.etsyPaymentStatus).toBe(flag === "canceled" ? "canceled" : "refund_pending");
    const [snapshot] = await db.select().from(etsyReceiptSnapshots).where(eq(etsyReceiptSnapshots.receiptLineId, receiptId));
    expect(flag === "canceled" ? snapshot.canceled : snapshot.refundDetected).toBe(true);
    await save([line({ receiptId, modifiedAt: new Date(now.getTime() + 60_000) })]);
    const [newer] = await db.select().from(orders).where(eq(orders.etsyReceiptId, receiptId));
    expect(newer.etsyPaymentStatus).toBe("paid");
    expect(newer.totalChf).toBe(blocked.totalChf);
    expect(await db.select().from(saleAlerts).where(eq(saleAlerts.etsyReceiptId, receiptId))).toHaveLength(1);
  });

  it.each(["canceled", "refunded"] as const)("keeps an equal-timestamp %s snapshot without creating matched or unmatched revenue", async (flag) => {
    const receiptId = flag === "canceled" ? "223456-301" : "223456-302";
    await save([line({ receiptId, [flag]: true })]);
    expect(await save([line({ receiptId })])).toEqual({ inserted: 0, unmatched: 0 });
    expect(await saveReceipts(db, [line({ receiptId, etsyListingId: "unknown" })], new Map(), {
      shopId, isDemo: false, offsite: () => false,
    })).toEqual({ inserted: 0, unmatched: 0 });
    expect(await db.select().from(orders).where(eq(orders.etsyReceiptId, receiptId))).toHaveLength(0);
  });

  it("rolls back snapshot acceptance when the order insert fails", async () => {
    const receiptId = "223456-401";
    const invalid = line({ receiptId, buyerCountry: null as unknown as string });
    await expect(save([invalid])).rejects.toThrow();
    expect(await db.select().from(etsyReceiptSnapshots).where(eq(etsyReceiptSnapshots.receiptLineId, receiptId))).toHaveLength(0);
    expect((await save([line({ receiptId })])).inserted).toBe(1);
  });

  it("preserves compound receipt identity and the owning shop on a cross-shop collision", async () => {
    const receiptId = "223456-501";
    await save([line({ receiptId })]);
    const [otherShop] = await db.insert(shops).values({ slug: "observations-other", displayName: "Other" }).returning();
    expect(await saveReceipts(db, [line({ receiptId, refunded: true })], new Map(), {
      shopId: otherShop.id, isDemo: false, offsite: () => false,
    })).toEqual({ inserted: 0, unmatched: 0 });
    const [order] = await db.select().from(orders).where(eq(orders.etsyReceiptId, receiptId));
    expect(order.shopId).toBe(shopId);
    expect(order.etsyReceiptId).toBe(receiptId);
    expect(order.etsyPaymentStatus).toBe("paid");
    const otherSnapshots = await db.select().from(etsyReceiptSnapshots).where(and(
      eq(etsyReceiptSnapshots.shopId, otherShop.id), eq(etsyReceiptSnapshots.receiptLineId, receiptId),
    ));
    expect(otherSnapshots).toHaveLength(1);
    expect(otherSnapshots[0].refundDetected).toBe(true);
  });

  it("only alerts once when concurrent paid observations target the same receipt", async () => {
    const receiptId = "223456-601";
    const results = await Promise.all([save([line({ receiptId })]), save([line({ receiptId })])]);
    expect(results.reduce((sum, result) => sum + result.inserted, 0)).toBe(1);
    expect(await db.select().from(orders).where(eq(orders.etsyReceiptId, receiptId))).toHaveLength(1);
    expect(await db.select().from(saleAlerts).where(eq(saleAlerts.etsyReceiptId, receiptId))).toHaveLength(1);
  });

  it("retains legacy demo persistence without creating source snapshots", async () => {
    const receiptId = "dry-observation-701";
    await saveReceipts(db, [line({ receiptId })], new Map([["456", listing]]), {
      shopId, isDemo: true, offsite: () => false,
    });
    const [order] = await db.select().from(orders).where(eq(orders.etsyReceiptId, receiptId));
    expect(order.isDemo).toBe(true);
    expect(order.podOrderId).toBeNull();
    expect(await db.select().from(etsyReceiptSnapshots).where(eq(etsyReceiptSnapshots.receiptLineId, receiptId))).toHaveLength(0);
  });

  it("replays accepted observations with a fresh statement when a concurrent insert was not visible", async () => {
    const receiptId = "223456-801";
    await save([line({ receiptId })]);
    const execute = db.execute.bind(db);
    const spy = vi.spyOn(db, "execute").mockImplementationOnce(() =>
      execute(sql`select null::integer as id, true as accepted, false as updated`));
    await save([line({ receiptId, canceled: true, modifiedAt: new Date(now.getTime() + 60_000) })]);
    expect(spy).toHaveBeenCalledTimes(2);
    const [order] = await db.select().from(orders).where(eq(orders.etsyReceiptId, receiptId));
    expect(order.etsyPaymentStatus).toBe("canceled");
  });

  it("does not let a fresh-snapshot replay overwrite a newer accepted observation", async () => {
    const receiptId = "223456-802";
    await save([line({ receiptId, modifiedAt: new Date(now.getTime() + 120_000) })]);
    const execute = db.execute.bind(db);
    const spy = vi.spyOn(db, "execute").mockImplementationOnce(() =>
      execute(sql`select null::integer as id, true as accepted, false as updated`));
    await save([line({ receiptId, canceled: true, modifiedAt: new Date(now.getTime() + 60_000) })]);
    expect(spy).toHaveBeenCalledTimes(2);
    const [order] = await db.select().from(orders).where(eq(orders.etsyReceiptId, receiptId));
    expect(order.etsyPaymentStatus).toBe("paid");
    const [snapshot] = await db.select().from(etsyReceiptSnapshots).where(eq(etsyReceiptSnapshots.receiptLineId, receiptId));
    expect(snapshot.sourceModifiedAt).toEqual(new Date(now.getTime() + 120_000));
  });

  it("does not reactivate canceled revenue on a newer unpaid observation", async () => {
    const receiptId = "223456-901";
    await save([line({ receiptId })]);
    await save([line({ receiptId, canceled: true })]);
    await save([line({ receiptId, paid: false, modifiedAt: new Date(now.getTime() + 60_000) })]);
    const [order] = await db.select().from(orders).where(eq(orders.etsyReceiptId, receiptId));
    expect(order.etsyPaymentStatus).toBe("canceled");
    const [snapshot] = await db.select().from(etsyReceiptSnapshots).where(eq(etsyReceiptSnapshots.receiptLineId, receiptId));
    expect(snapshot.paid).toBe(false);
  });
});

describe("missing analytics is not zero analytics", () => {
  it("preserves historical views and invalidates conversion freshness on a partial response", async () => {
    vi.stubEnv("DEMO_MODE", "false");
    state.stats = { "456": { views: null, favorites: 9 } };
    await runAnalytics({ db, shopId, demo: false, now, random: Math.random, trigger: "manual", log: () => {} });
    const [row] = await db.select().from(listings).where(eq(listings.id, listing.id));
    expect(row.views).toBe(120);
    expect(row.favorites).toBe(9);
    expect(row.analyticsCheckedAt).toBeNull();
  });

  it("invalidates freshness when a listing is absent from the response", async () => {
    vi.stubEnv("DEMO_MODE", "false");
    await db.update(listings).set({ analyticsCheckedAt: now }).where(eq(listings.id, listing.id));
    state.stats = {};
    await runAnalytics({ db, shopId, demo: false, now, random: Math.random, trigger: "manual", log: () => {} });
    const [row] = await db.select().from(listings).where(eq(listings.id, listing.id));
    expect(row.views).toBe(120);
    expect(row.analyticsCheckedAt).toBeNull();
  });
});
