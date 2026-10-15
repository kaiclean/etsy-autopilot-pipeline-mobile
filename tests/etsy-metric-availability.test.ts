import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { dailyStats, listings, orders, shops } from "@/db/schema";
import { dayKey } from "@/lib/format";
import { getAnalytics, getHomeData } from "@/lib/queries";

const database = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("@/db", () => ({ getDb: database.getDb }));
let client: PGlite;
let db: ReturnType<typeof drizzle>;
let listingId: number;

beforeAll(async () => {
  vi.stubEnv("DEMO_MODE", "false");
  client = new PGlite("memory://");
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  database.getDb.mockResolvedValue(db as unknown as DB);
  const [shop] = await db.select().from(shops);
  const [listing] = await db.insert(listings).values({
    shopId: shop.id, niche: "alpine", productType: "digital", status: "published", publishMode: "live",
    etsyListingId: "123", title: "Alpine print", tags: [], description: "Art", imageUrl: "/api/preview/1",
    priceChf: 100, podCostChf: 0, netChf: 90, marginPct: 90, views: 2000, favorites: 20,
  }).returning();
  listingId = listing.id;
  await db.insert(dailyStats).values({ date: dayKey(new Date()), views: 20, favorites: 2, isDemo: false });
  for (const [index, status] of (["paid", "canceled", "refund_pending"] as const).entries()) {
    await db.insert(orders).values({
      shopId: shop.id, listingId, etsyReceiptId: `${100 + index}-1`, etsyPaymentStatus: status,
      buyerCountry: "CH", totalChf: 100, feesChf: 10, profitChf: 90, fulfillmentStatus: "delivered_digital",
    });
  }
});
afterAll(async () => { vi.unstubAllEnvs(); await client.close(); });

it("does not present historical counters as a current conversion measurement", async () => {
  const analytics = await getAnalytics();
  const home = await getHomeData();
  expect(analytics.totals.conversion).toBeNull();
  expect(home.kpis["7d"].cur.conversion).toBeNull();
  expect(home.kpis["7d"].cur.views).toBeNull();
  expect(analytics.totals.revenue).toBe(100);
  expect(analytics.totals.orders).toBe(1);
  expect(home.kpis["7d"].cur.revenue).toBe(100);
});

it("requires complete fresh observations before exposing a snapshot ratio", async () => {
  await db.update(listings).set({ analyticsCheckedAt: new Date() }).where(eq(listings.id, listingId));
  const analytics = await getAnalytics();
  const home = await getHomeData();
  expect(analytics.totals.conversion).toBe(5);
  expect(home.kpis["7d"].cur.views).toBe(20);
  await db.update(listings).set({ analyticsCheckedAt: new Date(Date.now() - 48 * 3600_000) }).where(eq(listings.id, listingId));
  expect((await getAnalytics()).totals.conversion).toBeNull();
});
