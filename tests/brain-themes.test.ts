import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { cleanThemeInput, ensureThemeSeeds, listThemes, resetThemeSeedCache, runnableThemes, SEED_THEMES, themeCandidates, themeRunnable } from "@/lib/themes";
import { generateIdeaCandidates, upcomingMonths, DAILY_CANDIDATE_LIMIT } from "@/lib/brain/idea-feed";
import { mapIdea } from "@/lib/brain/mapper";
import { getVault } from "@/lib/brain/vault";
import { getFirstSale } from "@/lib/brain/first-sale";
import { validateListing } from "@/lib/listing-validator";

async function freshDb() {
  const client = new PGlite("memory://");
  const db = drizzle(client, { schema }) as DB;
  const folder = path.join(process.cwd(), "drizzle");
  await migrate(db, { migrationsFolder: folder });
  return { client, db };
}

describe("themes registry", () => {
  it("migration 0025 is idempotent and seeds once", async () => {
    const { client, db } = await freshDb();
    try {
      const sql = (await import("node:fs")).readFileSync(path.join(process.cwd(), "drizzle/0025_themes_registry.sql"), "utf8");
      for (const stmt of sql.split("--> statement-breakpoint")) if (stmt.trim()) await client.exec(stmt);
      resetThemeSeedCache(); await ensureThemeSeeds(db); resetThemeSeedCache(); await ensureThemeSeeds(db);
      const all = await listThemes(db);
      expect(all).toHaveLength(SEED_THEMES.length);
      const runnable = await runnableThemes(db);
      expect(runnable.map((t) => t.id)).not.toContain("swiss-planners");
      expect(runnable.every(themeRunnable)).toBe(true);
      const cands = await themeCandidates(db);
      expect(cands.length).toBeGreaterThan(0);
      expect(cands.every((c) => c.themeId)).toBe(true);
    } finally { await client.close(); }
  });

  it("validates editor input", () => {
    expect(cleanThemeInput({ label: "x", baseNiche: "alpine", status: "active", seeds: [], products: ["poster"] }).ok).toBe(false);
    expect(cleanThemeInput({ label: "Lake art", baseNiche: "nope", status: "active", seeds: [], products: ["poster"] }).ok).toBe(false);
    const planner = cleanThemeInput({ label: "Budget planner", baseNiche: "alpine", status: "active", seeds: ["chf budget planner"], products: ["planner"] });
    expect(planner.ok && planner.row.blocker).toBeTruthy();
    const ok = cleanThemeInput({ label: "Lake Art!", baseNiche: "alpine", status: "active", seeds: ["Lake Geneva Poster", "x"], products: ["poster"] });
    expect(ok.ok && ok.row).toMatchObject({ id: "lake-art", seeds: ["lake geneva poster"], blocker: null });
  });
});

describe("idea mapper", () => {
  it("classifies every vault idea honestly", () => {
    const ideas = getVault().notes.filter((n) => n.kind === "idea");
    expect(ideas.length).toBeGreaterThan(0);
    for (const n of ideas) {
      const m = mapIdea(n, SEED_THEMES.map((t) => ({ ...t, createdAt: new Date(), updatedAt: new Date() })));
      expect(["product", "software", "content"]).toContain(m.kind);
      if (m.pipelineReady) expect(m.theme?.runnable).toBe(true);
      if (m.kind !== "product" && m.derivative) expect(m.derivative.note.toLowerCase()).toMatch(/file|hand/);
    }
  });
});

describe("daily idea feed", () => {
  it("adds seasonal candidates, dedupes, respects the limit", async () => {
    const { client, db } = await freshDb();
    try {
      resetThemeSeedCache(); await ensureThemeSeeds(db);
      const now = new Date("2026-09-15T08:00:00Z");
      expect(upcomingMonths(now)).toEqual([8, 9, 10]);
      await generateIdeaCandidates(db, now);
      const first = await db.select().from(schema.ideaCandidates);
      expect(first.length).toBeGreaterThan(0);
      expect(first.length).toBeLessThanOrEqual(DAILY_CANDIDATE_LIMIT);
      expect(first.every((c) => c.status === "pending")).toBe(true);
      await generateIdeaCandidates(db, now);
      const second = await db.select().from(schema.ideaCandidates);
      expect(new Set(second.map((c) => c.phrase)).size).toBe(second.length);
      const keywords = await db.select().from(schema.keywords);
      expect(keywords).toHaveLength(0); // nothing reaches the pipeline without Kai
    } finally { await client.close(); }
  });

  it("first-sale tracker starts at zero", async () => {
    const { client, db } = await freshDb();
    try {
      const fs = await getFirstSale(db, "00000000-0000-4000-8000-000000000001", false);
      expect(fs).toMatchObject({ live: 0, orders: 0, pendingApproval: 0, stage: 0 });
    } finally { await client.close(); }
  });
});

describe("skill title rules", () => {
  const base = { description: "A calm alpine illustration printed on a ceramic mug.\n\nMade with AI-assisted design.", tags: Array.from({ length: 13 }, (_, i) => `alpine tag${i}`) };
  it("flags short titles, praise and a buried primary phrase", () => {
    const codes = (title: string, primaryPhrase?: string) => validateListing({ ...base, title, primaryPhrase } as never).issues.map((i) => i.code);
    expect(codes("Swiss Alps Mug")).toContain("title_word_count");
    expect(codes("Stunning Swiss Alps Mug with Calm Lake Scene")).toContain("empty_praise");
    expect(codes("Calm Lake Scene Mug for Coffee Lovers and Hikers with Swiss Alps", "swiss alps")).toContain("primary_not_first");
    expect(codes("Swiss Alps Mug with Calm Alpine Lake Scene", "swiss alps")).not.toContain("primary_not_first");
  });
});
