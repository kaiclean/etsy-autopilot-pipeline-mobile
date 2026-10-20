import path from "node:path";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";

const seen = vi.hoisted(() => ({ ids: [] as string[] }));
vi.mock("@/adapters/etsy", () => ({
  getEtsyAdapter: async () => ({
    mode: "live",
    getListingStats: async (rows: { etsyListingId: string }[]) => {
      seen.ids = rows.map((row) => row.etsyListingId);
      return Object.fromEntries(rows.map((row) => [row.etsyListingId, { views: 5, favorites: 1 }]));
    },
  }),
}));

describe("analytics stage on a live shop", () => {
  it("syncs only real live Etsy listings, not dry-run ids", async () => {
    const db = drizzle(new PGlite("memory://"), { schema }) as unknown as DB;
    await migrate(db as never, { migrationsFolder: path.join(process.cwd(), "drizzle") });
    const [shop] = await db.select().from(schema.shops).where(eq(schema.shops.slug, "omnishop-ch"));
    const base = { shopId: shop.id, niche: "alpine" as const, productType: "digital" as const, title: "t", tags: [], description: "d", imageUrl: "https://e/a.png", priceChf: 9, netChf: 5, marginPct: 50, status: "published" as const };
    await db.insert(schema.listings).values([
      { ...base, etsyListingId: "1800000001", publishMode: "live" },
      { ...base, etsyListingId: "1800000002", publishMode: "dry-run" },
    ]);
    const { runAnalytics } = await import("@/pipeline/analytics");
    const logs: string[] = [];
    await runAnalytics({ db, shopId: shop.id, demo: false, trigger: "cron", random: Math.random, now: new Date(), log: (msg) => { logs.push(msg); } });
    expect(seen.ids).toEqual(["1800000001"]);
    expect(logs.join("\n")).toMatch(/across 1 live listings/);
    expect(logs.join("\n")).not.toMatch(/unavailable metrics/);
  });
});

import { filterProducts } from "@/lib/catalog-filters";
describe("On Etsy filter", () => {
  it("excludes dry-run published drafts", () => {
    const rows = [
      { id: 1, status: "published", publishMode: "live", title: "a", tags: [], niche: "alpine", imageUrl: "https://e/a.png", validation: [] },
      { id: 2, status: "published", publishMode: "dry-run", title: "b", tags: [], niche: "alpine", imageUrl: "https://e/b.png", validation: [] },
    ] as unknown as Parameters<typeof filterProducts>[0];
    expect(filterProducts(rows, { query: "", niche: "all", status: "published" }).map((row) => (row as unknown as { id: number }).id)).toEqual([1]);
  });
});
