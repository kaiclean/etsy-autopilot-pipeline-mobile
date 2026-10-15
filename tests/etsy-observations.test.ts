import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getDb, type DB } from "@/db";
import { listings, orders, shops, type Listing } from "@/db/schema";
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
});
afterEach(() => vi.unstubAllEnvs());

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
    await save([line({ modifiedAt: new Date(now.getTime() - 60_000) })]);
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
