import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { jobRuns, keywords, listings } from "@/db/schema";
import { getSetting, setSetting } from "@/lib/settings";
import { runStage } from "@/pipeline/runner";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("research outcomes", () => {
  it("fails when both Etsy sources are empty, even if seed keywords are selected", async () => {
    vi.stubEnv("ETSY_INSIGHTS_CSV", "");
    vi.stubEnv("ETSY_INSIGHTS_PATH", "");
    vi.stubEnv("ETSY_DEMAND_SOURCE", "");
    vi.stubEnv("ETSY_API_COMPETITION", "false");
    const client = new PGlite("memory://");
    try {
      const db = drizzle(client, { schema }) as DB;
      await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
      const run = await runStage("research", "manual", { db });
      expect(run.status).toBe("failed");
      expect(run.summary).toMatch(/Etsy demand data.*missing/i);
      expect(run.summary).toContain("Reconnect Etsy");
      expect(run.summary).not.toContain("selected 0");
      expect((await db.select().from(jobRuns).where(eq(jobRuns.id, run.id)))[0].status).toBe("failed");
    } finally {
      await client.close();
    }
  });

  it("fails when an Etsy API 403 leaves both Etsy sources empty", async () => {
    vi.stubEnv("ETSY_INSIGHTS_CSV", "");
    vi.stubEnv("ETSY_INSIGHTS_PATH", "");
    vi.stubEnv("ETSY_DEMAND_SOURCE", "");
    vi.stubEnv("ETSY_API_COMPETITION", "true");
    vi.stubEnv("ETSY_API_KEY", "test-key");
    const fetch = vi.fn(async () => new Response(null, { status: 403 }));
    vi.stubGlobal("fetch", fetch);
    const client = new PGlite("memory://");
    try {
      const db = drizzle(client, { schema }) as DB;
      await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
      await setSetting(db, "automation", { ...await getSetting(db, "automation"), designsPerRun: 0 });
      const run = await runStage("research", "manual", { db });
      expect(fetch).toHaveBeenCalled();
      expect(run.status).toBe("failed");
      expect(run.summary).toContain("selected 0");
      expect(run.summary).toMatch(/Etsy demand data.*missing/i);
      expect(run.summary).toContain("Reconnect Etsy");
    } finally {
      await client.close();
    }
  });

  it("warns when Etsy data is present but the per-run design limit is zero", async () => {
    vi.stubEnv("ETSY_INSIGHTS_CSV", "keyword,search_volume,competition,niche\nswiss mountain print,1200,0.4,alpine");
    vi.stubEnv("ETSY_API_COMPETITION", "false");
    const client = new PGlite("memory://");
    try {
      const db = drizzle(client, { schema }) as DB;
      await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
      await setSetting(db, "automation", { ...await getSetting(db, "automation"), designsPerRun: 0 });
      const run = await runStage("research", "manual", { db });
      expect(run.status).toBe("warning");
      expect(run.summary).toContain("selected 0");
      expect(run.summary).toMatch(/designs per run.*0/i);
      expect(await db.select().from(keywords).where(eq(keywords.status, "selected"))).toEqual([]);
      expect((await db.select().from(jobRuns).where(eq(jobRuns.id, run.id)))[0].status).toBe("warning");
    } finally {
      await client.close();
    }
  });

  it("recognizes Etsy API competition candidates when Insights is empty", async () => {
    vi.stubEnv("ETSY_INSIGHTS_CSV", "");
    vi.stubEnv("ETSY_INSIGHTS_PATH", "");
    vi.stubEnv("ETSY_DEMAND_SOURCE", "");
    vi.stubEnv("ETSY_API_COMPETITION", "true");
    vi.stubEnv("ETSY_API_KEY", "test-key");
    const fetch = vi.fn(async () => Response.json({ count: 0 }));
    vi.stubGlobal("fetch", fetch);
    const client = new PGlite("memory://");
    try {
      const db = drizzle(client, { schema }) as DB;
      await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
      await setSetting(db, "automation", { ...await getSetting(db, "automation"), designsPerRun: 0 });
      const run = await runStage("research", "manual", { db });
      expect(fetch).toHaveBeenCalled();
      expect(run.status).toBe("warning");
      expect(run.summary).toMatch(/designs per run.*0/i);
    } finally {
      await client.close();
    }
  });

  it("retains the selection limit, score ordering and existing status eligibility", async () => {
    vi.stubEnv("ETSY_INSIGHTS_CSV", "keyword,search_volume,competition,niche\nswiss unique high print,100000,0,alpine\nswiss unique low print,0,1,alpine");
    vi.stubEnv("ETSY_API_COMPETITION", "false");
    const client = new PGlite("memory://");
    try {
      const db = drizzle(client, { schema }) as DB;
      await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
      await setSetting(db, "automation", { ...await getSetting(db, "automation"), designsPerRun: 1 });
      await db.insert(keywords).values({ phrase: "swiss unique high print", niche: "alpine", source: "test", status: "used" });
      const now = new Date("2026-11-15T12:00:00Z");
      const run = await runStage("research", "manual", { db, now });
      expect(run.status).toBe("success");
      const high = (await db.select().from(keywords).where(eq(keywords.phrase, "swiss unique high print")))[0];
      const low = (await db.select().from(keywords).where(eq(keywords.phrase, "swiss unique low print")))[0];
      expect(high).toMatchObject({ status: "used", score: 0.9 });
      expect(low).toMatchObject({ status: "new", score: 0.15 });
      expect(await db.select().from(keywords).where(eq(keywords.status, "selected")))
        .toMatchObject([{ phrase: "alpine christmas print", score: 0.74 }]);
      await db.update(keywords).set({ status: "used" }).where(eq(keywords.status, "new"));
      await db.update(keywords).set({ status: "new" }).where(eq(keywords.id, low.id));
      const lowRun = await runStage("research", "manual", { db, now });
      expect(lowRun.status).toBe("success");
      expect((await db.select().from(keywords).where(eq(keywords.id, low.id)))[0])
        .toMatchObject({ status: "selected", score: 0.15 });
      const empty = await runStage("research", "manual", { db, now });
      expect(empty.status).toBe("warning");
      expect(empty.summary).toMatch(/no .*eligible.*new keywords/i);
    } finally {
      await client.close();
    }
  });
});

describe("research-to-listing promise filtering", () => {
  it("does not select or list an Etsy Insights keyword promising a set of 3", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubEnv("ETSY_INSIGHTS_CSV", "keyword,search_volume,competition,niche\nswiss travel poster set of 3,1200,0.4,alpine");
    vi.stubEnv("RESEARCH_GOOGLE_TRENDS", "false");
    vi.stubEnv("ETSY_API_COMPETITION", "false");
    const client = new PGlite("memory://");
    try {
      const db = drizzle(client, { schema }) as DB;
      await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
      await db.insert(keywords).values({
        phrase: "swiss travel poster set of 3",
        niche: "alpine",
        source: "legacy-test",
        status: "selected",
      });
      const research = await runStage("research", "manual", { db, random: () => 0.2 });
      expect(research.status).toBe("success");
      expect(await db.select().from(keywords).where(eq(keywords.phrase, "swiss travel poster set of 3")))
        .toMatchObject([{ status: "rejected" }]);
      const listing = await runStage("listing", "manual", { db });
      expect(listing.summary).toContain("No new designs");
      expect(await db.select().from(listings)).toEqual([]);
    } finally {
      await client.close();
    }
  });
});
