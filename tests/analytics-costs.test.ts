import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeAll, describe, expect, it, vi } from "vitest";
import AnalyticsPage from "@/app/(app)/analytics/page";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { costs, orders, shops } from "@/db/schema";
import { chf, dayKey } from "@/lib/format";
import { getAnalytics, getHomeData } from "@/lib/queries";

const database = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("@/db", () => ({ getDb: database.getDb }));
vi.mock("@/components/analytics/charts", () => ({
  NicheChart: () => null, RevenueChart: () => null, TrafficChart: () => null,
}));
vi.mock("@/components/analytics/export-csv", () => ({ AnalyticsExport: () => null }));

describe("actual dashboard costs", () => {
  const now = new Date();
  const day = 864e5;
  const ages = [0, 1, 7, 30];

  beforeAll(async () => {
    const db = drizzle(new PGlite("memory://"), { schema });
    await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
    database.getDb.mockResolvedValue(db as unknown as DB);
    const [shop] = await db.select().from(shops).where(eq(shops.slug, "omnishop-ch"));
    for (const age of ages) {
      const createdAt = new Date(now.getTime() - age * day);
      await db.insert(orders).values({
        shopId: shop.id, etsyReceiptId: `123456-${age}`, buyerCountry: "CH",
        totalChf: 100, feesChf: 10, profitChf: 90,
        fulfillmentStatus: "delivered_digital", createdAt,
      });
      await db.insert(costs).values([
        { shopId: shop.id, kind: "ads_estimate", amountChf: 40, createdAt },
        { shopId: shop.id, kind: "ads_actual", amountChf: 5, createdAt },
        { shopId: shop.id, kind: "ai_image", amountChf: 2, createdAt },
        { shopId: shop.id, kind: "ai_text", amountChf: 1, createdAt },
        { shopId: shop.id, kind: "listing_fee", amountChf: 3, createdAt },
      ]);
    }
  });

  it("excludes estimates from current and previous home KPI ranges", async () => {
    const home = await getHomeData();
    for (const [range, days] of [["today", 1], ["7d", 7], ["30d", 30]] as const) {
      const current = ages.filter((age) => age < days).length;
      const previous = ages.filter((age) => age >= days && age < days * 2).length;
      expect(home.kpis[range].cur.net).toBe(current * 82);
      expect(home.kpis[range].prev.net).toBe(previous * 82);
      expect(home.kpis[range].cur.costs).toBe(current * 8);
    }
    expect(home.series.find((row) => row.date === dayKey(now))?.costs).toBe(8);
    const analytics = await getAnalytics();
    expect(home.kpis["30d"].cur.net).toBe(analytics.totals.netProfit);
  });

  it("renders the ad estimate outside deductible waterfall rows", async () => {
    const analytics = await getAnalytics();
    const html = renderToStaticMarkup(await AnalyticsPage());
    expect(html).toContain(`Etsy Ads estimate (not actual spend): ${chf(analytics.costByKind.ads_estimate)}`);
    expect(html).not.toContain(chf(-analytics.costByKind.ads_estimate));
    expect(html).toContain(chf(-analytics.costByKind.ads_actual));
    expect(html).toContain("estimates are not deducted");
  });
});
