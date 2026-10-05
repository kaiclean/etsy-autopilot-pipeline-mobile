import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const drizzleDir = path.join(process.cwd(), "drizzle");
const migrationPath = path.join(drizzleDir, "0003_shop_registry.sql");
const priorMigrations = ["0000_green_leader.sql", "0001_push_storage_printify.sql", "0002_delivery_gates.sql"];
const stampedTables = ["keywords", "designs", "listings", "orders", "job_runs", "events", "costs"] as const;

function statements(sql: string) {
  return sql
    .split("--> statement-breakpoint")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

async function applyStatements(db: PGlite, parts: string[]) {
  for (const statement of parts) {
    await db.exec(statement);
  }
}

async function applyFile(db: PGlite, file: string) {
  await applyStatements(db, statements(readFileSync(file, "utf8")));
}

describe("0003 shop registry migration", () => {
  const sql = readFileSync(migrationPath, "utf8");

  it("guards every create, column, and constraint so a partial run can be retried", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION current_omnishop_id()");
    expect(sql).toContain('ON CONFLICT ("slug") DO NOTHING');
    expect(sql).toContain("EXCEPTION WHEN duplicate_object THEN NULL;");
    expect(sql).not.toMatch(/CREATE TABLE(?! IF NOT EXISTS)/);
    expect(sql).not.toMatch(/ADD COLUMN(?! IF NOT EXISTS)/);
    expect(sql).not.toMatch(/CREATE(?: UNIQUE)? INDEX(?! IF NOT EXISTS)/);
    expect(sql).not.toMatch(/\bDROP\b|\bTRUNCATE\b|\bDELETE\s+FROM\b/);

    const parts = statements(sql);
    expect(parts.some((part) => part.length === 0)).toBe(false);
    const constraints = parts.filter((part) => part.includes("ADD CONSTRAINT"));
    expect(constraints.length).toBeGreaterThan(0);
    for (const part of constraints) {
      expect(part.startsWith("DO $$ BEGIN")).toBe(true);
      expect(part).toContain("EXCEPTION WHEN duplicate_object THEN NULL;");
      expect(part.trimEnd().endsWith("END $$;")).toBe(true);
    }

    for (const table of stampedTables) {
      expect(sql).toContain(`UPDATE "${table}" SET "shop_id" = current_omnishop_id() WHERE "shop_id" IS NULL`);
      const setDefault = sql.indexOf(`ALTER TABLE "${table}" ALTER COLUMN "shop_id" SET DEFAULT current_omnishop_id()`);
      const setNotNull = sql.indexOf(`ALTER TABLE "${table}" ALTER COLUMN "shop_id" SET NOT NULL`);
      expect(setDefault).toBeGreaterThan(-1);
      expect(setNotNull).toBeGreaterThan(setDefault);
    }
  });

  it("keeps the journal timestamp after 0002 and not in the future", () => {
    const journal = JSON.parse(readFileSync(path.join(drizzleDir, "meta/_journal.json"), "utf8")) as {
      entries: { tag: string; when: number; idx: number }[];
    };
    const previous = journal.entries.find((entry) => entry.tag === "0002_delivery_gates");
    const current = journal.entries.find((entry) => entry.tag === "0003_shop_registry");
    expect(previous?.when).toBeTypeOf("number");
    expect(current?.idx).toBe(3);
    expect(current?.when).toBeGreaterThan(previous!.when);
    expect(current?.when).toBeLessThanOrEqual(Date.now());

    const snapshot0002 = JSON.parse(readFileSync(path.join(drizzleDir, "meta/0002_snapshot.json"), "utf8")) as { id: string; prevId: string };
    const snapshot0001 = JSON.parse(readFileSync(path.join(drizzleDir, "meta/0001_snapshot.json"), "utf8")) as { id: string; prevId: string };
    expect(snapshot0002.prevId).toBe(snapshot0001.id);
  });

  it("applies twice against throwaway Postgres after a partial run", async () => {
    const db = new PGlite();
    try {
      for (const file of priorMigrations) {
        await applyFile(db, path.join(drizzleDir, file));
      }
      await db.exec(`INSERT INTO keywords (phrase, niche, source) VALUES ('alpine sunrise', 'wall', 'test')`);

      const parts = statements(sql);
      const columnAt = parts.findIndex((part) => part.includes('ADD COLUMN IF NOT EXISTS "shop_id"'));
      expect(columnAt).toBeGreaterThan(0);
      await applyStatements(db, parts.slice(0, columnAt));
      await applyStatements(db, parts);
      const [stamped] = (
        await db.query<{ shop_id: string }>(`SELECT shop_id::text AS shop_id FROM keywords WHERE phrase = 'alpine sunrise'`)
      ).rows;
      expect(stamped.shop_id).toBeTruthy();

      await db.exec(`INSERT INTO keywords (phrase, niche, source) VALUES ('alpine dusk', 'wall', 'test')`);
      await applyStatements(db, parts);

      const shops = await db.query<{ n: number; slug: string }>(
        `SELECT count(*)::int AS n, min(slug) AS slug FROM shops`,
      );
      expect(shops.rows[0]).toEqual({ n: 1, slug: "omnishop-ch" });

      const keywords = await db.query<{ phrase: string; shop_id: string }>(
        `SELECT phrase, shop_id::text AS shop_id FROM keywords ORDER BY phrase`,
      );
      expect(keywords.rows).toEqual([
        { phrase: "alpine dusk", shop_id: stamped.shop_id },
        { phrase: "alpine sunrise", shop_id: stamped.shop_id },
      ]);

      const columns = await db.query<{ table_name: string; is_nullable: string; column_default: string | null }>(`
        SELECT table_name, is_nullable, column_default
        FROM information_schema.columns
        WHERE column_name = 'shop_id'
          AND table_name IN ('keywords', 'designs', 'listings', 'orders', 'job_runs', 'events', 'costs')
        ORDER BY table_name
      `);
      expect(columns.rows.map((row) => row.table_name)).toEqual([...stampedTables].sort());
      for (const row of columns.rows) {
        expect(row.is_nullable).toBe("NO");
        expect(row.column_default).toContain("current_omnishop_id()");
      }

      const constraints = await db.query<{ conname: string }>(`
        SELECT con.conname
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        WHERE con.conname LIKE '%_shop_id_shops_id_fk'
        ORDER BY con.conname
      `);
      expect(constraints.rows.map((row) => row.conname)).toEqual([
        "costs_shop_id_shops_id_fk",
        "designs_shop_id_shops_id_fk",
        "events_shop_id_shops_id_fk",
        "job_runs_shop_id_shops_id_fk",
        "keywords_shop_id_shops_id_fk",
        "listings_shop_id_shops_id_fk",
        "orders_shop_id_shops_id_fk",
        "shop_automation_shop_id_shops_id_fk",
        "shop_connections_shop_id_shops_id_fk",
      ]);
    } finally {
      await db.close();
    }
  });
});

describe("0004 POD Etsy id sync migration", () => {
  const migrationPath = path.join(drizzleDir, "0004_pod_etsy_id_sync.sql");
  const chain = [...priorMigrations, "0003_shop_registry.sql", "0004_pod_etsy_id_sync.sql"];
  const sql = readFileSync(migrationPath, "utf8");

  it("guards columns and the not-null backfill so a partial run can be retried", () => {
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS");
    expect(sql).toContain(`ALTER TABLE "orders" ALTER COLUMN "match_status" SET DEFAULT 'matched'`);
    expect(sql).toContain(`UPDATE "orders" SET "match_status" = 'matched' WHERE "match_status" IS NULL`);
    expect(sql).toContain(`AND "etsy_listing_id" IS NULL`);
    expect(sql).not.toMatch(/ADD COLUMN(?! IF NOT EXISTS)/);
    expect(sql).not.toMatch(/\bDROP\b|\bTRUNCATE\b|\bDELETE\s+FROM\b/);

    const setDefault = sql.indexOf(`ALTER TABLE "orders" ALTER COLUMN "match_status" SET DEFAULT 'matched'`);
    const fillNulls = sql.indexOf(`WHERE "match_status" IS NULL`);
    const setNotNull = sql.indexOf(`ALTER TABLE "orders" ALTER COLUMN "match_status" SET NOT NULL`);
    expect(setDefault).toBeGreaterThan(-1);
    expect(fillNulls).toBeGreaterThan(setDefault);
    expect(setNotNull).toBeGreaterThan(fillNulls);

    const parts = statements(sql);
    const constraints = parts.filter((part) => part.includes("ADD CONSTRAINT"));
    for (const part of constraints) {
      expect(part.startsWith("DO $$ BEGIN")).toBe(true);
      expect(part).toContain("EXCEPTION WHEN duplicate_object THEN NULL;");
      expect(part.trimEnd().endsWith("END $$;")).toBe(true);
    }
  });

  it("keeps the journal timestamp after 0003 and not in the future", () => {
    const journal = JSON.parse(readFileSync(path.join(drizzleDir, "meta/_journal.json"), "utf8")) as {
      entries: { tag: string; when: number; idx: number }[];
    };
    const previous = journal.entries.find((entry) => entry.tag === "0003_shop_registry");
    const current = journal.entries.find((entry) => entry.tag === "0004_pod_etsy_id_sync");
    expect(previous?.when).toBe(1791291651763);
    expect(current?.idx).toBe(4);
    expect(current?.when).toBeGreaterThan(previous!.when);
    expect(current?.when).toBeLessThanOrEqual(Date.now());
  });

  it("applies 0000 through 0004 and accepts 0004 a second time", async () => {
    const db = new PGlite();
    try {
      for (const file of chain.slice(0, -1)) {
        await applyFile(db, path.join(drizzleDir, file));
      }
      await db.exec(`
        INSERT INTO listings (niche, product_type, title, tags, description, image_url, price_chf, net_chf, margin_pct, status, etsy_listing_id, printify_product_id, published_at)
        VALUES
          ('alpine', 'pod', 'Stuck poster', '[]'::jsonb, 'desc', '/art.png', 24.9, 8, 30, 'published', NULL, 'pfy-stuck', now()),
          ('alpine', 'pod', 'Live poster', '[]'::jsonb, 'desc', '/art.png', 24.9, 8, 30, 'published', '111222333', 'pfy-live', now()),
          ('alpine', 'pod', 'Sent product', '[]'::jsonb, 'desc', '/art.png', 24.9, 8, 30, 'pod_created', NULL, 'pfy-sent', NULL),
          ('alpine', 'pod', 'Unsent product', '[]'::jsonb, 'desc', '/art.png', 24.9, 8, 30, 'pod_created', NULL, 'pfy-unsent', NULL);
        UPDATE listings SET pod_published_at = now() WHERE printify_product_id = 'pfy-sent';
        INSERT INTO orders (etsy_receipt_id, buyer_country, total_chf, fees_chf, profit_chf, fulfillment_status)
        VALUES ('receipt-before-0004', 'CH', 24.9, 4, 10, 'pending');
      `);

      const parts = statements(sql);
      const fillAt = parts.findIndex((part) => part.includes(`WHERE "match_status" IS NULL`));
      expect(fillAt).toBeGreaterThan(0);
      await applyStatements(db, parts.slice(0, fillAt));
      await db.exec(`
        INSERT INTO orders (etsy_receipt_id, buyer_country, total_chf, fees_chf, profit_chf, fulfillment_status, match_status)
        VALUES ('receipt-partial-null', 'DE', 19.9, 3, 8, 'pending', NULL);
      `);
      await applyStatements(db, parts);
      await applyStatements(db, parts);
      await applyStatements(db, parts);

      const listingsAfter = await db.query<{ title: string; status: string; etsy_listing_id: string | null }>(`
        SELECT title, status, etsy_listing_id FROM listings ORDER BY title
      `);
      expect(listingsAfter.rows).toEqual([
        { title: "Live poster", status: "published", etsy_listing_id: "111222333" },
        { title: "Sent product", status: "publishing", etsy_listing_id: null },
        { title: "Stuck poster", status: "publishing", etsy_listing_id: null },
        { title: "Unsent product", status: "pod_created", etsy_listing_id: null },
      ]);

      const ordersAfter = await db.query<{ etsy_receipt_id: string; match_status: string }>(`
        SELECT etsy_receipt_id, match_status FROM orders ORDER BY etsy_receipt_id
      `);
      expect(ordersAfter.rows).toEqual([
        { etsy_receipt_id: "receipt-before-0004", match_status: "matched" },
        { etsy_receipt_id: "receipt-partial-null", match_status: "matched" },
      ]);

      await db.exec(`
        INSERT INTO orders (etsy_receipt_id, buyer_country, total_chf, fees_chf, profit_chf, fulfillment_status)
        VALUES ('receipt-after-0004', 'CH', 12, 2, 6, 'pending');
      `);
      const [defaulted] = (
        await db.query<{ match_status: string }>(`SELECT match_status FROM orders WHERE etsy_receipt_id = 'receipt-after-0004'`)
      ).rows;
      expect(defaulted.match_status).toBe("matched");

      const columns = await db.query<{ column_name: string; table_name: string; is_nullable: string; column_default: string | null }>(`
        SELECT column_name, table_name, is_nullable, column_default
        FROM information_schema.columns
        WHERE (table_name = 'listings' AND column_name = 'etsy_id_wait_alerted_at')
           OR (table_name = 'orders' AND column_name IN ('match_status', 'unmatched_etsy_listing_id'))
        ORDER BY table_name, column_name
      `);
      expect(columns.rows).toEqual([
        { column_name: "etsy_id_wait_alerted_at", table_name: "listings", is_nullable: "YES", column_default: null },
        { column_name: "match_status", table_name: "orders", is_nullable: "NO", column_default: "'matched'::text" },
        { column_name: "unmatched_etsy_listing_id", table_name: "orders", is_nullable: "YES", column_default: null },
      ]);

      const shops = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM shops`);
      expect(shops.rows[0].n).toBe(1);
    } finally {
      await db.close();
    }
  });
});

describe("0005 pricing floor migration", () => {
  const migrationPath = path.join(drizzleDir, "0005_pricing_floor_profit.sql");
  const chain = [...priorMigrations, "0003_shop_registry.sql", "0004_pod_etsy_id_sync.sql"];
  const sql = readFileSync(migrationPath, "utf8");

  it("sets defaults before not-null and backfills only nulls", () => {
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS");
    expect(sql).not.toMatch(/ADD COLUMN(?! IF NOT EXISTS)/);
    expect(sql).not.toMatch(/\bDROP\b|\bTRUNCATE\b|\bDELETE\s+FROM\b/);
    for (const column of ["refunded_chf", "profit_basis"] as const) {
      const setDefault = sql.indexOf(`ALTER TABLE "orders" ALTER COLUMN "${column}" SET DEFAULT`);
      const fillNulls = sql.indexOf(`UPDATE "orders" SET "${column}"`);
      const setNotNull = sql.indexOf(`ALTER TABLE "orders" ALTER COLUMN "${column}" SET NOT NULL`);
      expect(setDefault).toBeGreaterThan(-1);
      expect(fillNulls).toBeGreaterThan(setDefault);
      expect(sql.slice(fillNulls, setNotNull)).toContain("IS NULL");
      expect(setNotNull).toBeGreaterThan(fillNulls);
    }
  });

  it("keeps the journal timestamp after 0004 and not in the future", () => {
    const journal = JSON.parse(readFileSync(path.join(drizzleDir, "meta/_journal.json"), "utf8")) as {
      entries: { tag: string; when: number; idx: number }[];
    };
    const previous = journal.entries.find((entry) => entry.tag === "0004_pod_etsy_id_sync");
    const current = journal.entries.find((entry) => entry.tag === "0005_pricing_floor_profit");
    expect(previous?.when).toBe(1791300000000);
    expect(current?.idx).toBe(5);
    expect(current?.when).toBeGreaterThan(previous!.when);
    expect(current?.when).toBeLessThanOrEqual(Date.now());
  });

  it("applies 0000 through 0005 and accepts 0005 a second and third time", async () => {
    const db = new PGlite();
    try {
      for (const file of chain) {
        await applyFile(db, path.join(drizzleDir, file));
      }
      await db.exec(`
        INSERT INTO orders (etsy_receipt_id, buyer_country, total_chf, fees_chf, profit_chf, fulfillment_status)
        VALUES ('receipt-before-0005', 'CH', 24.9, 4, 10, 'pending');
      `);
      const parts = statements(sql);
      const fillAt = parts.findIndex((part) => part.includes(`"refunded_chf" = 0 WHERE "refunded_chf" IS NULL`));
      expect(fillAt).toBeGreaterThan(0);
      await applyStatements(db, parts.slice(0, fillAt));
      await db.exec(`
        INSERT INTO orders (etsy_receipt_id, buyer_country, total_chf, fees_chf, profit_chf, fulfillment_status, refunded_chf)
        VALUES ('receipt-partial-null', 'DE', 19.9, 3, 8, 'pending', NULL);
      `);
      await applyStatements(db, parts);
      await applyStatements(db, parts);
      await applyStatements(db, parts);

      const rows = await db.query<{ etsy_receipt_id: string; refunded_chf: number; profit_basis: string }>(`
        SELECT etsy_receipt_id, refunded_chf, profit_basis FROM orders ORDER BY etsy_receipt_id
      `);
      expect(rows.rows).toEqual([
        { etsy_receipt_id: "receipt-before-0005", refunded_chf: 0, profit_basis: "estimated" },
        { etsy_receipt_id: "receipt-partial-null", refunded_chf: 0, profit_basis: "estimated" },
      ]);

      const columns = await db.query<{ column_name: string; table_name: string; is_nullable: string }>(`
        SELECT column_name, table_name, is_nullable
        FROM information_schema.columns
        WHERE (table_name = 'listings' AND column_name IN ('pod_cost_note', 'pod_variant_prices'))
           OR (table_name = 'orders' AND column_name IN ('refunded_chf', 'profit_basis'))
        ORDER BY table_name, column_name
      `);
      expect(columns.rows).toEqual([
        { column_name: "pod_cost_note", table_name: "listings", is_nullable: "YES" },
        { column_name: "pod_variant_prices", table_name: "listings", is_nullable: "YES" },
        { column_name: "profit_basis", table_name: "orders", is_nullable: "NO" },
        { column_name: "refunded_chf", table_name: "orders", is_nullable: "NO" },
      ]);
    } finally {
      await db.close();
    }
  });
});
