import { readFileSync } from "node:fs";
import { listings, shopConnections, shops } from "@/db/schema";
import { beforeAll, describe, expect, it } from "vitest";
import { getDb, type DB } from "@/db";
import { and, eq } from "drizzle-orm";
import { setSetting } from "@/lib/settings";
import { etsyShopIdFromEnv, listShopsPublic, readEtsyTokens, resolveActiveShop, syncShopRegistry, writeEtsyTokens } from "@/lib/shops";

process.env.PGLITE_DIR = "memory://m1-shop-registry";
process.env.ETSY_SHOP_ID = "68255203";
delete process.env.DATABASE_URL;

describe("M1 shop registry", () => {
  let db: DB;

  beforeAll(async () => {
    db = await getDb();
  });

  it("does not hardcode the shop id in SQL and ignores an empty env value", () => {
    const sql = readFileSync(new URL("../drizzle/0003_shop_registry.sql", import.meta.url), "utf8");
    expect(sql).not.toContain("68255203");
    expect(sql).toContain("omnishop-ch");
    expect(etsyShopIdFromEnv("")).toBeNull();
    expect(etsyShopIdFromEnv("  68255203  ")).toBe("68255203");
    const route = readFileSync(new URL("../src/app/api/shops/route.ts", import.meta.url), "utf8");
    expect(route).toContain("export async function GET");
    expect(route).not.toContain("export async function POST");
  });

  it("backfills exactly one OmniShop CH shop from ETSY_SHOP_ID and stamps listings", async () => {
    await syncShopRegistry(db);
    const rows = await db.select().from(shops);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      slug: "omnishop-ch",
      displayName: "OmniShop CH",
      etsyShopName: "OmniShopByKaiArt",
      etsyShopId: "68255203",
      currency: "CHF",
      locale: "en",
      marketLocale: "de-CH",
      publishMode: "dry-run",
      killSwitch: false,
    });
    expect(rows[0].status).not.toBe("live");

    const stamped = await db.select({ shopId: listings.shopId }).from(listings);
    expect(stamped.length).toBeGreaterThan(0);
    expect(stamped.every((row) => row.shopId === rows[0].id)).toBe(true);

    const active = await resolveActiveShop(db, null);
    expect(active.id).toBe(rows[0].id);
    const ignoredCookie = await resolveActiveShop(db, "00000000-0000-0000-0000-000000000000");
    expect(ignoredCookie.id).toBe(rows[0].id);
  });

  it("dual-reads Etsy tokens from shop_connections, then settings.etsyTokens", async () => {
    const [shop] = await db.select().from(shops);
    await setSetting(db, "etsyTokens", { accessToken: "legacy-token", refreshToken: "legacy-refresh", expiresAt: 1 });
    await db.update(shopConnections).set({ tokens: null }).where(eq(shopConnections.shopId, shop.id));
    expect((await readEtsyTokens(db, shop.id))?.accessToken).toBe("legacy-token");

    await writeEtsyTokens(db, shop.id, { accessToken: "shop-token", refreshToken: "shop-refresh", expiresAt: 2 });
    expect((await readEtsyTokens(db, shop.id))?.accessToken).toBe("shop-token");
    const [stored] = await db
      .select()
      .from(shopConnections)
      .where(and(eq(shopConnections.shopId, shop.id), eq(shopConnections.provider, "etsy")));
    const legacy = await readEtsyTokens(db, shop.id);
    expect(legacy?.accessToken).toBe("shop-token");
    expect(JSON.stringify(stored.tokens)).toContain("shop-token");

    const pubs = await listShopsPublic(db);
    expect(JSON.stringify(pubs)).not.toContain("shop-token");
    expect(JSON.stringify(pubs)).not.toContain("shop-refresh");
    expect(pubs[0].connections.map((row) => row.provider).sort()).toEqual(["etsy", "openrouter", "printify", "s3"]);
  });
});
