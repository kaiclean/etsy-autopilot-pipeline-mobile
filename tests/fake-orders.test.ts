import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import { clearFakeOrders } from "@/db/clear-fake-orders";
import * as schema from "@/db/schema";
import { costs, dailyStats, events, jobRuns, listings, orders, shops } from "@/db/schema";
import { ordersListQuery } from "@/lib/queries";
import { receiptLookback, shouldSimulateReceipts } from "@/lib/real-orders";
import { runAnalytics } from "@/pipeline/analytics";
import { runOrders } from "@/pipeline/orders";
import type { StageContext } from "@/pipeline/types";

const etsyState = vi.hoisted(() => ({
  mode: "dry-run" as "dry-run" | "live",
  receipts: [] as {
    receiptId: string;
    etsyListingId: string;
    buyerCountry: string;
    quantity: number;
    totalChf: number;
    createdAt: Date;
  }[],
  calls: [] as { since: Date; simulateAtLeastOne?: boolean; candidateIds: string[] }[],
  statsIds: [] as string[][],
}));

vi.mock("@/adapters/etsy", () => ({
  getEtsyAdapter: async () => ({
    mode: etsyState.mode,
    async getReceipts(opts: { since: Date; simulateAtLeastOne?: boolean; candidates: { etsyListingId: string }[] }) {
      etsyState.calls.push({
        since: opts.since,
        simulateAtLeastOne: opts.simulateAtLeastOne,
        candidateIds: opts.candidates.map((row) => row.etsyListingId),
      });
      return etsyState.receipts;
    },
    async getListingStats(current: { etsyListingId: string; views: number; favorites: number }[]) {
      etsyState.statsIds.push(current.map((row) => row.etsyListingId));
      return Object.fromEntries(current.map((row) => [row.etsyListingId, { views: row.views + 4, favorites: row.favorites }]));
    },
    async createDraftListing() {
      return { listingId: "dry-x" };
    },
    async uploadListingImage() {},
    async uploadListingFile() {},
    async activateListing() {},
  }),
}));

const NOW = new Date("2026-10-06T12:00:00.000Z");
const originalDemo = process.env.DEMO_MODE;

async function memoryDb() {
  const client = new PGlite("memory://");
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  return db as unknown as DB;
}

async function omnishop(db: DB) {
  const [shop] = await db.select().from(shops).where(eq(shops.slug, "omnishop-ch"));
  if (!shop) throw new Error("omnishop missing");
  return shop;
}

function stageCtx(db: DB, shopId: string, extra: Partial<StageContext> = {}): StageContext {
  return {
    db,
    shopId,
    demo: false,
    trigger: "cron",
    random: () => 0,
    now: NOW,
    log: () => {},
    ...extra,
  };
}

async function insertListing(
  db: DB,
  shopId: string,
  extra: { etsyListingId: string; isDemo?: boolean; views?: number; title?: string },
) {
  const [row] = await db
    .insert(listings)
    .values({
      shopId,
      niche: "alpine",
      productType: "digital",
      title: extra.title ?? "Alpine print",
      tags: ["alpine"],
      description: "A print",
      imageUrl: "/api/placeholder/1",
      priceChf: 12.5,
      netChf: 4.25,
      marginPct: 34,
      status: "published",
      etsyListingId: extra.etsyListingId,
      views: extra.views ?? 0,
      isDemo: extra.isDemo ?? false,
    })
    .returning();
  return row;
}

async function insertOrder(
  db: DB,
  shopId: string,
  extra: { etsyReceiptId: string; totalChf: number; profitChf: number; isDemo: boolean; createdAt: Date; listingId?: number },
) {
  const [row] = await db
    .insert(orders)
    .values({
      shopId,
      etsyReceiptId: extra.etsyReceiptId,
      listingId: extra.listingId,
      buyerCountry: "CH",
      quantity: 1,
      totalChf: extra.totalChf,
      feesChf: 1,
      profitChf: extra.profitChf,
      fulfillmentStatus: "delivered_digital",
      isDemo: extra.isDemo,
      createdAt: extra.createdAt,
    })
    .returning();
  return row;
}

beforeEach(() => {
  etsyState.mode = "dry-run";
  etsyState.receipts = [];
  etsyState.calls = [];
  etsyState.statsIds = [];
  process.env.DEMO_MODE = "false";
});

afterEach(() => {
  if (originalDemo === undefined) delete process.env.DEMO_MODE;
  else process.env.DEMO_MODE = originalDemo;
});

describe("analytics ignores demo and dry-run orders", () => {
  it("counts only real receipts for the active shop", async () => {
    const db = await memoryDb();
    const shop = await omnishop(db);
    const [other] = await db
      .insert(shops)
      .values({ slug: "other-shop", displayName: "Other", currency: "CHF", locale: "en" })
      .returning();
    const realListing = await insertListing(db, shop.id, { etsyListingId: "445566", views: 1 });
    const demoListing = await insertListing(db, shop.id, { etsyListingId: "demo-4100", isDemo: true, views: 7, title: "Seed listing" });
    const otherListing = await insertListing(db, other.id, { etsyListingId: "778899", views: 3, title: "Other shop" });

    await insertOrder(db, shop.id, {
      etsyReceiptId: "3899001-1",
      totalChf: 12.5,
      profitChf: 4.25,
      isDemo: false,
      createdAt: new Date("2026-09-20T08:00:00.000Z"),
      listingId: realListing.id,
    });
    await insertOrder(db, shop.id, {
      etsyReceiptId: "100-old",
      totalChf: 99,
      profitChf: 40,
      isDemo: false,
      createdAt: new Date("2026-08-01T08:00:00.000Z"),
      listingId: realListing.id,
    });
    await insertOrder(db, shop.id, {
      etsyReceiptId: "9001",
      totalChf: 40,
      profitChf: 10,
      isDemo: true,
      createdAt: new Date("2026-09-28T08:00:00.000Z"),
      listingId: demoListing.id,
    });
    await insertOrder(db, shop.id, {
      etsyReceiptId: "dry-r-manual-1",
      totalChf: 50,
      profitChf: 20,
      isDemo: false,
      createdAt: new Date("2026-10-01T08:00:00.000Z"),
      listingId: realListing.id,
    });
    await insertOrder(db, shop.id, {
      etsyReceiptId: "demo-r-1-0",
      totalChf: 25,
      profitChf: 8,
      isDemo: false,
      createdAt: new Date("2026-09-29T08:00:00.000Z"),
      listingId: demoListing.id,
    });
    await insertOrder(db, other.id, {
      etsyReceiptId: "555-other",
      totalChf: 80,
      profitChf: 30,
      isDemo: false,
      createdAt: new Date("2026-10-02T08:00:00.000Z"),
      listingId: otherListing.id,
    });

    const summary = await runAnalytics(stageCtx(db, shop.id));
    expect(summary).toBe("30d: 1 orders, revenue CHF 12.50, profit after fees CHF 4.25 · +4 views");
    expect(etsyState.statsIds).toEqual([["445566"]]);

    const [demoAfter] = await db.select({ views: listings.views }).from(listings).where(eq(listings.id, demoListing.id));
    const [otherAfter] = await db.select({ views: listings.views }).from(listings).where(eq(listings.id, otherListing.id));
    expect(demoAfter.views).toBe(7);
    expect(otherAfter.views).toBe(3);
  });

  it("still drops seed and dry-run receipt ids when demo mode is on", async () => {
    process.env.DEMO_MODE = "true";
    const db = await memoryDb();
    const shop = await omnishop(db);
    await insertOrder(db, shop.id, {
      etsyReceiptId: "3899001-1",
      totalChf: 12.5,
      profitChf: 4.25,
      isDemo: false,
      createdAt: new Date("2026-09-20T08:00:00.000Z"),
    });
    await insertOrder(db, shop.id, {
      etsyReceiptId: "9001",
      totalChf: 40,
      profitChf: 10,
      isDemo: true,
      createdAt: new Date("2026-09-28T08:00:00.000Z"),
    });
    await insertOrder(db, shop.id, {
      etsyReceiptId: "dry-r-manual-1",
      totalChf: 50,
      profitChf: 20,
      isDemo: true,
      createdAt: new Date("2026-10-01T08:00:00.000Z"),
    });
    await insertOrder(db, shop.id, {
      etsyReceiptId: "demo-r-1-0",
      totalChf: 25,
      profitChf: 8,
      isDemo: true,
      createdAt: new Date("2026-09-29T08:00:00.000Z"),
    });

    const summary = await runAnalytics(stageCtx(db, shop.id, { demo: true }));
    expect(summary).toContain("30d: 2 orders, revenue CHF 52.50, profit after fees CHF 14.25");
  });
});

describe("receipt cursor ignores fake rows", () => {
  it("ignores newer fake rows and still refreshes the last 30 days", async () => {
    const db = await memoryDb();
    const shop = await omnishop(db);
    const [other] = await db
      .insert(shops)
      .values({ slug: "other-shop", displayName: "Other", currency: "CHF", locale: "en" })
      .returning();
    const listing = await insertListing(db, shop.id, { etsyListingId: "445566" });
    const realAt = new Date("2026-09-20T08:00:00.000Z");
    await insertOrder(db, shop.id, {
      etsyReceiptId: "3899001-1",
      totalChf: 12.5,
      profitChf: 4.25,
      isDemo: false,
      createdAt: realAt,
      listingId: listing.id,
    });
    await insertOrder(db, shop.id, {
      etsyReceiptId: "dry-r-newer",
      totalChf: 50,
      profitChf: 20,
      isDemo: false,
      createdAt: new Date("2026-10-05T08:00:00.000Z"),
      listingId: listing.id,
    });
    await insertOrder(db, shop.id, {
      etsyReceiptId: "demo-r-newer",
      totalChf: 25,
      profitChf: 8,
      isDemo: true,
      createdAt: new Date("2026-10-04T08:00:00.000Z"),
      listingId: listing.id,
    });
    await insertOrder(db, other.id, {
      etsyReceiptId: "555-other",
      totalChf: 80,
      profitChf: 30,
      isDemo: false,
      createdAt: new Date("2026-10-05T09:00:00.000Z"),
    });

    etsyState.mode = "live";
    await runOrders(stageCtx(db, shop.id, { trigger: "manual" }));
    expect(etsyState.calls).toHaveLength(1);
    const refresh = new Date(NOW.getTime() - 30 * 864e5);
    expect(refresh.getTime()).toBeLessThan(realAt.getTime());
    expect(etsyState.calls[0].since.toISOString()).toBe(refresh.toISOString());
    expect(etsyState.calls[0].since.toISOString()).not.toBe("2026-10-05T08:00:00.000Z");
    expect(etsyState.calls[0].since.toISOString()).not.toBe("2026-10-04T08:00:00.000Z");
    expect(etsyState.calls[0].since.toISOString()).not.toBe("2026-10-05T09:00:00.000Z");
    expect(etsyState.calls[0].simulateAtLeastOne).toBe(false);
    expect(etsyState.calls[0].candidateIds).toEqual(["445566"]);
  });

  it("falls back to the earlier of shop created_at and a 60-day lookback", async () => {
    const db = await memoryDb();
    const shop = await omnishop(db);
    const opened = new Date("2026-06-01T00:00:00.000Z");
    await db.update(shops).set({ createdAt: opened }).where(eq(shops.id, shop.id));
    await insertListing(db, shop.id, { etsyListingId: "445566" });
    await insertOrder(db, shop.id, {
      etsyReceiptId: "dry-r-only",
      totalChf: 50,
      profitChf: 20,
      isDemo: false,
      createdAt: new Date("2026-10-05T08:00:00.000Z"),
    });

    etsyState.mode = "live";
    await runOrders(stageCtx(db, shop.id, { trigger: "cron" }));
    expect(etsyState.calls[0].since.toISOString()).toBe(opened.toISOString());
    expect(etsyState.calls[0].simulateAtLeastOne).toBe(false);

    const recentOpen = new Date("2026-09-27T00:00:00.000Z");
    await db.update(shops).set({ createdAt: recentOpen }).where(eq(shops.id, shop.id));
    await runOrders(stageCtx(db, shop.id, { trigger: "manual" }));
    expect(etsyState.calls[1].since.toISOString()).toBe(receiptLookback(NOW, recentOpen).toISOString());
    expect(etsyState.calls[1].since.toISOString()).toBe("2026-08-07T12:00:00.000Z");
    expect(shouldSimulateReceipts("live", "manual")).toBe(false);
    expect(shouldSimulateReceipts("dry-run", "manual")).toBe(true);
    expect(shouldSimulateReceipts("dry-run", "cron")).toBe(false);
  });
});

describe("dry-run receipts are stored as demo", () => {
  it("marks simulated receipts demo and does not insert the same receipt twice", async () => {
    const db = await memoryDb();
    const shop = await omnishop(db);
    await insertListing(db, shop.id, { etsyListingId: "445566" });
    const createdAt = new Date("2026-10-06T11:00:00.000Z");
    etsyState.mode = "dry-run";
    etsyState.receipts = [
      {
        receiptId: "dry-r-test-1",
        etsyListingId: "445566",
        buyerCountry: "DE",
        quantity: 1,
        totalChf: 12.5,
        createdAt,
      },
    ];

    const first = await runOrders(stageCtx(db, shop.id, { trigger: "manual", demo: false }));
    expect(first).toContain("1 new order");
    expect(etsyState.calls[0].simulateAtLeastOne).toBe(true);
    const [saved] = await db.select().from(orders).where(eq(orders.etsyReceiptId, "dry-r-test-1"));
    expect(saved.isDemo).toBe(true);
    expect(saved.shopId).toBe(shop.id);
    const [event] = await db.select().from(events).where(eq(events.type, "order.new"));
    expect(event.isDemo).toBe(true);

    const second = await runOrders(stageCtx(db, shop.id, { trigger: "manual", demo: false }));
    expect(second).toContain("0 new order");
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(orders).where(eq(orders.etsyReceiptId, "dry-r-test-1"));
    expect(Number(n)).toBe(1);

    etsyState.mode = "live";
    etsyState.receipts = [
      {
        receiptId: "3899002-9",
        etsyListingId: "445566",
        buyerCountry: "CH",
        quantity: 1,
        totalChf: 12.5,
        createdAt,
      },
    ];
    await runOrders(stageCtx(db, shop.id, { trigger: "manual", demo: false }));
    expect(etsyState.calls.at(-1)?.simulateAtLeastOne).toBe(false);
    const [live] = await db.select().from(orders).where(eq(orders.etsyReceiptId, "3899002-9"));
    expect(live.isDemo).toBe(false);
    expect(etsyState.calls.at(-1)?.since.toISOString()).not.toBe(createdAt.toISOString());
  });
});

describe("db:clear-fake-orders", () => {
  it("counts without deleting on dry-run, then deletes only fake rows", async () => {
    const db = await memoryDb();
    const shop = await omnishop(db);
    const listing = await insertListing(db, shop.id, { etsyListingId: "demo-1", isDemo: true, title: "Keep me" });
    await insertOrder(db, shop.id, {
      etsyReceiptId: "3899001-1",
      totalChf: 12.5,
      profitChf: 4.25,
      isDemo: false,
      createdAt: NOW,
      listingId: listing.id,
    });
    await insertOrder(db, shop.id, {
      etsyReceiptId: "9001",
      totalChf: 40,
      profitChf: 10,
      isDemo: true,
      createdAt: NOW,
    });
    await insertOrder(db, shop.id, {
      etsyReceiptId: "dry-r-1",
      totalChf: 50,
      profitChf: 20,
      isDemo: false,
      createdAt: NOW,
    });
    await insertOrder(db, shop.id, {
      etsyReceiptId: "demo-r-1",
      totalChf: 25,
      profitChf: 8,
      isDemo: false,
      createdAt: NOW,
    });
    await db.insert(costs).values([
      { shopId: shop.id, kind: "ads", amountChf: 1, isDemo: false },
      { shopId: shop.id, kind: "ads", amountChf: 2, isDemo: true },
    ]);
    await db.insert(dailyStats).values([
      { date: "2026-10-01", views: 3, favorites: 0, isDemo: false },
      { date: "2026-10-02", views: 9, favorites: 1, isDemo: true },
    ]);
    await db.insert(jobRuns).values([
      { shopId: shop.id, stage: "orders", status: "success", trigger: "cron", isDemo: false },
      { shopId: shop.id, stage: "analytics", status: "success", trigger: "cron", isDemo: true },
    ]);
    await db.insert(events).values([
      { shopId: shop.id, type: "job.success", title: "real", isDemo: false },
      { shopId: shop.id, type: "order.new", title: "fake", isDemo: true },
    ]);

    const counted = await clearFakeOrders(db, { dryRun: true });
    expect(counted).toEqual({ orders: 3, costs: 1, dailyStats: 1, jobRuns: 1, events: 1 });
    const [{ before }] = await db.select({ before: sql<number>`count(*)::int` }).from(orders);
    expect(Number(before)).toBe(4);

    const deleted = await clearFakeOrders(db, { dryRun: false });
    expect(deleted).toEqual(counted);
    const remaining = await db.select({ id: orders.etsyReceiptId }).from(orders);
    expect(remaining.map((row) => row.id)).toEqual(["3899001-1"]);
    const [costCount] = await db.select({ n: sql<number>`count(*)::int` }).from(costs);
    const [statCount] = await db.select({ n: sql<number>`count(*)::int` }).from(dailyStats);
    const [runCount] = await db.select({ n: sql<number>`count(*)::int` }).from(jobRuns);
    const [eventCount] = await db.select({ n: sql<number>`count(*)::int` }).from(events);
    const [listingCount] = await db.select({ n: sql<number>`count(*)::int` }).from(listings);
    expect(Number(costCount.n)).toBe(1);
    expect(Number(statCount.n)).toBe(1);
    expect(Number(runCount.n)).toBe(1);
    expect(Number(eventCount.n)).toBe(1);
    expect(Number(listingCount.n)).toBe(1);

    process.env.DEMO_MODE = "true";
    await expect(clearFakeOrders(db, { dryRun: false })).rejects.toThrow(/DEMO_MODE=true/);
    const [{ afterRefuse }] = await db.select({ afterRefuse: sql<number>`count(*)::int` }).from(orders);
    expect(Number(afterRefuse)).toBe(1);
  });

  it("hides fake receipts on the orders list outside demo mode", async () => {
    const db = await memoryDb();
    const shop = await omnishop(db);
    const listing = await insertListing(db, shop.id, { etsyListingId: "445566" });
    await insertOrder(db, shop.id, {
      etsyReceiptId: "3899001-1",
      totalChf: 12.5,
      profitChf: 4.25,
      isDemo: false,
      createdAt: NOW,
      listingId: listing.id,
    });
    await insertOrder(db, shop.id, {
      etsyReceiptId: "dry-r-1",
      totalChf: 50,
      profitChf: 20,
      isDemo: false,
      createdAt: NOW,
      listingId: listing.id,
    });
    const live = await ordersListQuery(db);
    expect(live.map((row) => row.order.etsyReceiptId)).toEqual(["3899001-1"]);

    process.env.DEMO_MODE = "true";
    const demo = await ordersListQuery(db);
    expect(demo.map((row) => row.order.etsyReceiptId).sort()).toEqual(["3899001-1", "dry-r-1"]);
  });
});
