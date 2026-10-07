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
