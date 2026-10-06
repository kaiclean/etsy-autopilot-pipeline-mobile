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
