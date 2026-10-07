import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const drizzleDir = path.join(process.cwd(), "drizzle");
const migrationPath = path.join(drizzleDir, "0006_daily_ops.sql");
const prior = [
  "0000_green_leader.sql",
  "0001_push_storage_printify.sql",
  "0002_delivery_gates.sql",
  "0003_shop_registry.sql",
  "0004_pod_etsy_id_sync.sql",
];

function statements(sql: string) {
  return sql
    .split("--> statement-breakpoint")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

async function apply(db: PGlite, file: string) {
  for (const statement of statements(readFileSync(file, "utf8"))) {
    await db.exec(statement);
  }
}

describe("0006 daily ops migration", () => {
  const sql = readFileSync(migrationPath, "utf8");

  it("uses retry-safe statements and leaves 0005 for the pricing migration", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS");
    expect(sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS");
    expect(sql).toContain("EXCEPTION WHEN duplicate_object THEN NULL;");
    expect(sql).not.toMatch(/CREATE TABLE(?! IF NOT EXISTS)/);
    expect(sql).not.toMatch(/ADD COLUMN(?! IF NOT EXISTS)/);
    expect(sql).not.toMatch(/CREATE UNIQUE INDEX(?! IF NOT EXISTS)/);
    expect(sql).not.toMatch(/\bDROP\b|\bTRUNCATE\b|\bDELETE\s+FROM\b/);
    expect(readFileSync(path.join(drizzleDir, "meta/_journal.json"), "utf8")).not.toContain("0005_");

    const journal = JSON.parse(readFileSync(path.join(drizzleDir, "meta/_journal.json"), "utf8")) as {
      entries: { tag: string; when: number; idx: number }[];
    };
    const previous = journal.entries.find((entry) => entry.tag === "0004_pod_etsy_id_sync");
    const current = journal.entries.find((entry) => entry.tag === "0006_daily_ops");
    expect(current?.idx).toBe(5);
    expect(current?.when).toBeGreaterThan(previous!.when);
    expect(current?.when).toBeLessThanOrEqual(Date.now());
  });

  it("applies twice after a partial run", async () => {
    const db = new PGlite();
    try {
      for (const file of prior) await apply(db, path.join(drizzleDir, file));
      const parts = statements(sql);
      await db.exec(parts[0]);
      await apply(db, migrationPath);
      await apply(db, migrationPath);
      const tables = await db.query<{ table_name: string }>(
        "select table_name from information_schema.tables where table_schema = 'public' and table_name in ('design_briefs', 'health_reports', 'sale_alerts')",
      );
      expect(tables.rows.map((row) => row.table_name).sort()).toEqual(["design_briefs", "health_reports", "sale_alerts"]);
      const columns = await db.query<{ column_name: string }>(
        "select column_name from information_schema.columns where table_name = 'orders' and column_name in ('fulfillment_changed_at', 'fulfillment_stalled_at')",
      );
      expect(columns.rows.map((row) => row.column_name).sort()).toEqual(["fulfillment_changed_at", "fulfillment_stalled_at"]);
    } finally {
      await db.close();
    }
  });
});

describe("0007 publish attempt migration", () => {
  const file = path.join(drizzleDir, "0007_publish_attempt.sql");
  const sql = readFileSync(file, "utf8");

  it("adds the attempt clock idempotently after 0006", async () => {
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS");
    expect(sql).not.toMatch(/ADD COLUMN(?! IF NOT EXISTS)/);
    expect(sql).not.toMatch(/\bDROP\b|\bTRUNCATE\b|\bDELETE\s+FROM\b/);
    const journal = JSON.parse(readFileSync(path.join(drizzleDir, "meta/_journal.json"), "utf8")) as {
      entries: { tag: string; when: number; idx: number }[];
    };
    const previous = journal.entries.find((entry) => entry.tag === "0006_daily_ops");
    const current = journal.entries.find((entry) => entry.tag === "0007_publish_attempt");
    expect(current?.idx).toBe(6);
    expect(current?.when).toBeGreaterThan(previous!.when);
    expect(current?.when).toBeLessThanOrEqual(Date.now());

    const db = new PGlite();
    try {
      for (const name of [...prior, "0006_daily_ops.sql"]) await apply(db, path.join(drizzleDir, name));
      await db.exec(
        "insert into listings (niche, product_type, title, tags, description, image_url, price_chf, net_chf, margin_pct, status, publish_error) values ('alpine', 'pod', 'Poster', '[]'::jsonb, 'desc', '/img', 20, 5, 20, 'failed', 'same error')",
      );
      const parts = statements(sql);
      await db.exec(parts[0]);
      await apply(db, file);
      await apply(db, file);
      const columns = await db.query<{ column_name: string }>(
        "select column_name from information_schema.columns where table_name = 'listings' and column_name = 'publish_attempted_at'",
      );
      expect(columns.rows).toHaveLength(1);
      const rows = await db.query<{ publish_attempted_at: string | null }>("select publish_attempted_at from listings");
      expect(rows.rows[0].publish_attempted_at).toBeTruthy();
    } finally {
      await db.close();
    }
  });
});

describe("0008 design pixel migration", () => {
  const file = path.join(drizzleDir, "0008_design_pixels.sql");
  const sql = readFileSync(file, "utf8");

  it("adds print-file measurements idempotently after 0007", async () => {
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS");
    expect(sql).not.toMatch(/ADD COLUMN(?! IF NOT EXISTS)/);
    expect(sql).not.toMatch(/\bDROP\b|\bTRUNCATE\b|\bDELETE\s+FROM\b/);
    const journal = JSON.parse(readFileSync(path.join(drizzleDir, "meta/_journal.json"), "utf8")) as {
      entries: { tag: string; when: number; idx: number }[];
    };
    const previous = journal.entries.find((entry) => entry.tag === "0007_publish_attempt");
    const current = journal.entries.find((entry) => entry.tag === "0008_design_pixels");
    expect(current?.idx).toBe(7);
    expect(current?.when).toBeGreaterThan(previous!.when);
    expect(current?.when).toBeLessThanOrEqual(Date.now());

    const db = new PGlite();
    try {
      for (const name of [...prior, "0006_daily_ops.sql", "0007_publish_attempt.sql"]) await apply(db, path.join(drizzleDir, name));
      await apply(db, file);
      await apply(db, file);
      const columns = await db.query<{ column_name: string }>(
        "select column_name from information_schema.columns where table_name = 'designs' and column_name in ('image_width', 'image_height', 'color_variance')",
      );
      expect(columns.rows.map((row) => row.column_name).sort()).toEqual(["color_variance", "image_height", "image_width"]);
    } finally {
      await db.close();
    }
  });
});
