import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";
import { etsyAdapter } from "@/businesses/etsy";
import { pinterestAdapter } from "@/businesses/pinterest";
import * as schema from "@/db/schema";
import { shops } from "@/db/schema";
import { applyBusinessPublishMode, applyBusinessSpendCap, businessesForCron, insertBusiness } from "@/lib/businesses";
import { getSetting } from "@/lib/settings";
import { spendAllowed } from "@/lib/spend-cap";
import { runAnalytics } from "@/pipeline/analytics";
import { runDesign } from "@/pipeline/design";
import { runListing } from "@/pipeline/listing";
import { runOrders } from "@/pipeline/orders";
import { runPublish } from "@/pipeline/publish";
import { runResearch } from "@/pipeline/research";
import { runCronStage } from "@/pipeline/runner";
import type { DB } from "@/db";

const drizzleDir = path.join(process.cwd(), "drizzle");

function statements(sql: string) {
  return sql
    .split("--> statement-breakpoint")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

describe("0018 business registry migration", () => {
  const sql = readFileSync(path.join(drizzleDir, "0018_business_registry.sql"), "utf8");

  it("is the next free migration and stays idempotent without a transaction", () => {
    expect(sql).toContain("68255203");
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "kind"');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "parent_id"');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "config"');
    expect(sql).toContain("'pinterest'");
    expect(sql).toContain("'dry-run'");
    expect(sql).not.toMatch(/^\s*BEGIN\s*;|^\s*COMMIT\s*;|\bDROP\b|\bTRUNCATE\b/m);
    const journal = JSON.parse(readFileSync(path.join(drizzleDir, "meta/_journal.json"), "utf8")) as {
      entries: { tag: string; when: number; idx: number }[];
    };
    const tags = journal.entries.map((entry) => entry.tag);
    expect(tags).not.toContain("0016_sourcing");
    expect(tags).not.toContain("0017_marketplace_listings");
    const current = journal.entries.find((entry) => entry.tag === "0018_business_registry");
    const previous = journal.entries.find((entry) => entry.tag === "0015_hot_signals");
    expect(current?.idx).toBe(14);
    expect(current?.when).toBeGreaterThan(previous!.when);
    expect(current?.when).toBeLessThanOrEqual(Date.now());
  });

  it("backfills Etsy shop 68255203 as business 1 and can be applied twice", async () => {
    const client = new PGlite();
    try {
      const db = drizzle(client, { schema });
      await migrate(db, { migrationsFolder: drizzleDir });
      for (const statement of statements(sql)) await client.exec(statement);
      const rows = await db.select().from(shops);
      const etsy = rows.find((row) => row.slug === "omnishop-ch");
      const pin = rows.find((row) => row.slug === "pinterest");
      expect(etsy).toMatchObject({ kind: "etsy", etsyShopId: "68255203" });
      expect(etsy?.config).toMatchObject({ businessNumber: 1 });
      expect(pin).toMatchObject({
        kind: "pinterest",
        parentId: etsy?.id,
        publishMode: "dry-run",
        status: "dry-run",
        killSwitch: false,
      });
      expect(rows).toHaveLength(2);
      const columns = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'shops' AND column_name IN ('kind','parent_id','config') ORDER BY column_name`,
      );
      expect(columns.rows.map((row) => row.column_name)).toEqual(["config", "kind", "parent_id"]);
    } finally {
      await client.close();
    }
  });
});

describe("business adapters and safety", () => {
  it("wraps the current Etsy stages without replacing them", () => {
    expect(etsyAdapter.kind).toBe("etsy");
    expect(etsyAdapter.publishApproval).toBe("api");
    expect(etsyAdapter.connections).toEqual(["etsy", "printify", "s3", "openrouter"]);
    expect(etsyAdapter.stages.research).toBe(runResearch);
    expect(etsyAdapter.stages.produce).toBe(runDesign);
    expect(etsyAdapter.stages.list).toBe(runListing);
    expect(etsyAdapter.stages.publish).toBe(runPublish);
    expect(etsyAdapter.stages.orders).toBe(runOrders);
    expect(etsyAdapter.stages.analytics).toBe(runAnalytics);
    expect(pinterestAdapter.kind).toBe("pinterest");
    expect(pinterestAdapter.publishApproval).toBe("api");
    expect(pinterestAdapter.stages.list).toBeTypeOf("function");
    expect(pinterestAdapter.stages.publish).toBeTypeOf("function");
    expect(pinterestAdapter.stages.research).toBeUndefined();
  });

  it("keeps the global cap on top of a business cap", () => {
    expect(spendAllowed({ spentGlobal: 1.9, spentBusiness: 0, globalCap: 2, businessCap: 5, nextCost: 0.2 }).globalBlocks).toBe(true);
    expect(spendAllowed({ spentGlobal: 0, spentBusiness: 0.4, globalCap: 2, businessCap: 0.5, nextCost: 0.2 }).businessBlocks).toBe(true);
    expect(spendAllowed({ spentGlobal: 0, spentBusiness: 0, globalCap: 2, businessCap: 2, nextCost: 0.2 }).ok).toBe(true);
  });

  it("starts a new business in dry-run and requires CONFIRM, without touching Etsy publishing", async () => {
    const client = new PGlite();
    try {
      const db = drizzle(client, { schema }) as unknown as DB;
      await migrate(db, { migrationsFolder: drizzleDir });
      const created = await insertBusiness(db, { slug: "kdp", displayName: "KDP", kind: "kdp" });
      expect(created).toMatchObject({ publishMode: "dry-run", status: "dry-run", killSwitch: false, kind: "kdp" });
      const before = await getSetting(db, "automation");
      const [pin] = await db.select().from(shops).where(eq(shops.slug, "pinterest"));
      expect(await applyBusinessPublishMode(db, pin.id, "live", "confirm")).toMatchObject({ ok: false });
      expect(await applyBusinessPublishMode(db, pin.id, "live", "CONFIRM")).toMatchObject({ ok: true, publishMode: "live" });
      const [live] = await db.select().from(shops).where(eq(shops.id, pin.id));
      expect(live.publishMode).toBe("live");
      const [etsy] = await db.select().from(shops).where(eq(shops.slug, "omnishop-ch"));
      expect(await applyBusinessPublishMode(db, etsy.id, "live", "CONFIRM")).toMatchObject({ ok: false });
      expect((await db.select().from(shops).where(eq(shops.id, etsy.id)))[0].publishMode).toBe("dry-run");
      expect((await getSetting(db, "automation")).publishMode).toBe(before.publishMode);
      expect(await applyBusinessSpendCap(db, pin.id, -1)).toMatchObject({ ok: false });
      expect((await applyBusinessSpendCap(db, pin.id, 0.5)).ok).toBe(true);
      expect((await db.select().from(shops).where(eq(shops.id, pin.id)))[0].config).toMatchObject({ dailyAiCapChf: 0.5 });
    } finally {
      await client.close();
    }
  });

  it("runs cron for every enabled business unless a slug is passed", async () => {
    const client = new PGlite();
    try {
      const db = drizzle(client, { schema }) as unknown as DB;
      await migrate(db, { migrationsFolder: drizzleDir });
      const rows = await db.select().from(shops);
      expect(businessesForCron(rows, null).map((row) => row.slug).sort()).toEqual(["omnishop-ch", "pinterest"]);
      expect(businessesForCron(rows, "pinterest").map((row) => row.slug)).toEqual(["pinterest"]);
      await db.update(shops).set({ status: "paused" }).where(eq(shops.slug, "omnishop-ch"));
      const paused = await runCronStage("research", { db, now: new Date(), random: () => 0.2 });
      expect(paused.unknown).toBe(false);
      expect(paused.runs.map((run) => run.slug)).toEqual(["pinterest"]);
      expect(paused.runs[0]?.status).toBe("skipped");
      const missing = await runCronStage("research", { db, business: "missing-shop" });
      expect(missing.unknown).toBe(true);
    } finally {
      await client.close();
    }
  });
});
