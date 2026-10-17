import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";
import * as schema from "@/db/schema";

describe("marketplace listing storage", () => {
  it("auto-migrates idempotently and enforces listing references and marketplace uniqueness", async () => {
    const client = new PGlite("memory://");
    try {
      const db = drizzle(client, { schema });
      const migrationsFolder = path.join(process.cwd(), "drizzle");
      await migrate(db, { migrationsFolder });
      expect((await client.query("SELECT to_regclass('public.marketplace_listings') AS table_name")).rows)
        .toEqual([{ table_name: "marketplace_listings" }]);
      const sql = await readFile(path.join(migrationsFolder, "0017_marketplace_listings.sql"), "utf8");
      await client.exec(sql);
      await client.exec(sql);
      const [listing] = await db.insert(schema.listings).values({
        niche: "alpine", productType: "pod", title: "Alpine poster", description: "Poster",
        tags: ["alpine"], imageUrl: "https://example.com/mockup.png",
        priceChf: 29.9, netChf: 10, marginPct: 33,
      }).returning({ id: schema.listings.id });
      const insert = "INSERT INTO marketplace_listings (listing_id, marketplace) VALUES ($1, $2) RETURNING external_id, status, payload_preview, updated_at";
      const created = await client.query<{ external_id: string | null; status: string; payload_preview: unknown; updated_at: Date }>(
        insert, [listing.id, "shopify"],
      );
      expect(created.rows[0]).toMatchObject({ external_id: null, status: "draft", payload_preview: null });
      expect(created.rows[0].updated_at).toBeInstanceOf(Date);
      await expect(client.query(insert, [listing.id, "etsy"])).resolves.toBeDefined();
      await expect(client.query(insert, [listing.id, "shopify"])).rejects.toThrow(/unique constraint/);
      await expect(client.query(insert, [listing.id + 1, "shopify"])).rejects.toThrow(/foreign key constraint/);
      await client.exec(sql);
      expect((await client.query("SELECT count(*)::int AS total FROM marketplace_listings")).rows).toEqual([{ total: 2 }]);
    } finally {
      await client.close();
    }
  });
});
