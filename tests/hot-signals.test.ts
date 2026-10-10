import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, type DB } from "@/db";
import { hotSignalFetches, hotSignals, keywords } from "@/db/schema";
import { resolveActiveShop } from "@/lib/shops";
import { DEFAULT_STAGES, getSetting, setSetting } from "@/lib/settings";
import { loadHotSignals, mergeHotKeywords, rankHotSignals, scanHotSignals, type HotKeywordSource, type HotSignal } from "@/pipeline/hot-signals";
import { hotKeywordSource } from "@/pipeline/hot-signals/types";
import { runResearch } from "@/pipeline/research";
import { isStage, type StageContext } from "@/pipeline/types";

const now = new Date("2026-10-10T12:00:00Z");
const signal = (overrides: Partial<HotSignal> = {}): HotSignal => ({
  provider: "amazon", category: "home decor", title: "Swiss mountain print",
  phrase: "swiss mountain print", rank: null, badge: null, label_text: null, metric: null,
  source_url: "https://www.amazon.com/dp/FIXTURE001", fetched_at: now, ...overrides,
});
const source = (name: HotKeywordSource["name"], collectSignals: HotKeywordSource["collectSignals"]) =>
  hotKeywordSource(name, collectSignals);

describe("hot signal ranking", () => {
  it("missing fields contribute nothing, even across unmeasured search results", () => {
    const rows = rankHotSignals([signal(), signal({ provider: "etsy", source_url: "https://www.etsy.com/listing/123" })]);
    expect(rows.map((row) => row.score)).toEqual([0, 0]);
    expect(rows[0].metric).toBeNull();
    expect(rows[0].rank).toBeNull();
  });

  it("uses literal rank, badge, growth, label and independent provider agreement", () => {
    const rows = rankHotSignals([
      signal({ rank: 1 }),
      signal({ provider: "etsy", badge: "Bestseller", label_text: "3 sold in the last 24 hours", source_url: "https://www.etsy.com/listing/123" }),
      signal({ provider: "pinterest", metric: 50, source_url: "https://trends.pinterest.com/" }),
    ]);
    expect(rows[0].score).toBeCloseTo(0.7);
    expect(rows.find((row) => row.provider === "etsy")?.metric).toBeNull();
    expect(rows.find((row) => row.provider === "etsy")?.label_text).toBe("3 sold in the last 24 hours");
  });

  it("drops off-niche, unsafe URLs and invalid data; dedupes source/day without inventing agreement", () => {
    const rows = rankHotSignals([
      signal({ rank: 2 }), signal({ rank: 2 }),
      signal({ phrase: "phone charger", rank: 1 }),
      signal({ phrase: "mountain bike", rank: 1 }),
      signal({ phrase: "alpine hiking boots", rank: 1 }),
      signal({ source_url: "http://www.amazon.com/dp/a", rank: 1 }),
      signal({ source_url: "https://evil.example/a", rank: 1 }),
      signal({ source_url: "https://www.amazon.com/dp/b", rank: -1 }),
      signal({ source_url: "https://www.amazon.com/dp/c", metric: NaN }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].score).toBeCloseTo(0.5 / Math.sqrt(2));
  });

  it("retains observed badges when the same listing was first returned by an unmeasured API", () => {
    const api = signal({ provider: "etsy", source_url: "https://www.etsy.com/listing/123" });
    const scraped = { ...api, badge: "Bestseller" };
    expect(rankHotSignals([api, scraped])[0].badge).toBe("Bestseller");
    expect(rankHotSignals([scraped, api])[0].badge).toBe("Bestseller");
  });
});

describe("hot scan persistence and keyword integration", () => {
  let db: DB;
  let ctx: StageContext;
  beforeAll(async () => {
    db = await getDb();
    const shop = await resolveActiveShop(db);
    ctx = { db, shopId: shop.id, demo: false, trigger: "manual", now, random: () => 0.5, log: vi.fn() };
  });
  beforeEach(async () => {
    await db.delete(hotSignals);
    await db.delete(hotSignalFetches);
    await db.delete(keywords).where(eq(keywords.source, "hot:amazon"));
    vi.mocked(ctx.log).mockClear();
  });

  it("migration is idempotent, registers next journal entry and creates usable UTC daily index", async () => {
    const migration = readFileSync(new URL("../drizzle/0013_hot_signals.sql", import.meta.url), "utf8");
    for (let repeat = 0; repeat < 2; repeat++) {
      for (const statement of migration.split("--> statement-breakpoint")) await db.execute(sql.raw(statement));
    }
    const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
    expect(journal.entries.at(-1)).toMatchObject({ idx: 12, tag: "0013_hot_signals" });
    const collect = vi.fn(async () => [signal({ rank: 1 }), signal({ rank: 1 })]);
    await scanHotSignals(ctx, [source("amazon", collect)]);
    expect(await db.select().from(hotSignals)).toHaveLength(1);
  });

  it("caches for 20h, keeps actual fetched time, and never refreshes evidence timestamps on a cache hit", async () => {
    const collect = vi.fn(async (opts) => [signal({ rank: 1, fetched_at: opts.now })]);
    const sources = [source("amazon", collect)];
    await scanHotSignals(ctx, sources);
    await scanHotSignals({ ...ctx, now: new Date(now.getTime() + 19 * 3600_000) }, sources);
    expect(collect).toHaveBeenCalledTimes(1);
    expect((await db.select().from(hotSignals))[0].fetchedAt).toEqual(now);
    await scanHotSignals({ ...ctx, now: new Date(now.getTime() + 21 * 3600_000) }, sources);
    expect(collect).toHaveBeenCalledTimes(2);
    expect(await db.select().from(hotSignals)).toHaveLength(2);
  });

  it("caches successful empty results, isolates failures and makes no provider calls in demo", async () => {
    const empty = vi.fn(async () => []);
    const failure = vi.fn(async () => { throw new Error("private response must not be logged"); });
    const good = vi.fn(async () => [signal({ provider: "etsy", badge: "Bestseller", source_url: "https://www.etsy.com/listing/123" })]);
    const sources = [source("amazon", empty), source("pinterest", failure), source("etsy", good)];
    const result = await scanHotSignals(ctx, sources);
    expect(result.failed).toBe(1);
    expect(result.signals).toHaveLength(1);
    await scanHotSignals(ctx, sources);
    expect(empty).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
    expect(failure).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(vi.mocked(ctx.log).mock.calls)).not.toContain("private response");
    await scanHotSignals({ ...ctx, demo: true }, sources);
    expect(failure).toHaveBeenCalledTimes(2);
  });

  it("reuses fresh stored observations even without a provider cache marker", async () => {
    await db.insert(hotSignals).values({
      provider: "amazon", title: "Swiss mountain print", phrase: signal().phrase,
      rank: 1, sourceUrl: signal().source_url, fetchedAt: now,
    });
    const collect = vi.fn(async () => []);
    const result = await scanHotSignals(ctx, [source("amazon", collect)]);
    expect(collect).not.toHaveBeenCalled();
    expect(result.signals).toHaveLength(1);
  });

  it("updates a same-UTC-day refresh instead of renewing a cache for expired evidence", async () => {
    const first = new Date("2026-10-10T00:00:00Z");
    const second = new Date("2026-10-10T21:00:00Z");
    const collect = vi.fn(async (opts) => [signal({ rank: opts.now === first ? 10 : 1, fetched_at: opts.now })]);
    await scanHotSignals({ ...ctx, now: first }, [source("amazon", collect)]);
    await scanHotSignals({ ...ctx, now: second }, [source("amazon", collect)]);
    const rows = await db.select().from(hotSignals);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rank: 1, fetchedAt: second });
    expect(await loadHotSignals(db, ctx.shopId, new Date("2026-10-11T03:00:00Z"))).toHaveLength(1);
  });

  it("merges hot-only phrases without seed scores or changing lifecycle and scopes to the shop", async () => {
    const rows = rankHotSignals([signal({ rank: 1 })]);
    await mergeHotKeywords(ctx, rows);
    let [row] = await db.select().from(keywords).where(eq(keywords.phrase, signal().phrase));
    expect(row).toMatchObject({ source: "hot:amazon", score: 0.5, demandScore: 0, competitionScore: 0, seasonalityScore: 0, isDemo: false });
    await db.update(keywords).set({ status: "used" }).where(eq(keywords.id, row.id));
    await mergeHotKeywords(ctx, rows);
    [row] = await db.select().from(keywords).where(eq(keywords.id, row.id));
    expect(row.status).toBe("used");
    await mergeHotKeywords(ctx, rankHotSignals([signal({ phrase: "swiss null evidence print" })]));
    expect(await db.select().from(keywords).where(eq(keywords.phrase, "swiss null evidence print"))).toHaveLength(0);
  });

  it("research adds the bounded boost and merges new hot phrases without a rescan", async () => {
    const automation = await getSetting(db, "automation");
    await setSetting(db, "automation", { ...automation, designsPerRun: 0 });
    try {
      await runResearch(ctx);
      const [before] = await db.select().from(keywords).where(eq(keywords.phrase, "matterhorn print"));
      await scanHotSignals(ctx, [source("amazon", async () => [
        signal({ rank: 1, phrase: "matterhorn print" }),
        signal({ rank: 2, phrase: "swiss fresh observed print", source_url: "https://www.amazon.com/dp/FIXTURE002" }),
      ])]);
      await runResearch(ctx);
      const [after] = await db.select().from(keywords).where(eq(keywords.id, before.id));
      expect(after.score).toBeCloseTo(Math.min(1, before.score + 0.075));
      expect(after.demandScore).toBe(before.demandScore);
      expect((await db.select().from(keywords).where(eq(keywords.phrase, "swiss fresh observed print")))[0].source).toBe("hot:amazon");
      expect(await loadHotSignals(db, ctx.shopId, new Date(now.getTime() + 25 * 3600_000))).toHaveLength(0);
    } finally {
      await setSetting(db, "automation", automation);
    }
  });

  it("claims a demo keyword using only observed evidence and never demotes live keywords to demo", async () => {
    const phrase = "swiss observed demo print";
    const [demo] = await db.insert(keywords).values({
      shopId: ctx.shopId, phrase, niche: "alpine", source: "seed-list",
      score: 0.9, demandScore: 0.9, competitionScore: 0.5, seasonalityScore: 0.6, isDemo: true,
    }).returning();
    const real = rankHotSignals([signal({ phrase, rank: 1 })]);
    await mergeHotKeywords(ctx, real);
    expect((await db.select().from(keywords).where(eq(keywords.id, demo.id)))[0])
      .toMatchObject({ source: "hot:amazon", score: 0.5, demandScore: 0, competitionScore: 0, seasonalityScore: 0, isDemo: false });
    await mergeHotKeywords({ ...ctx, demo: true }, real);
    expect((await db.select().from(keywords).where(eq(keywords.id, demo.id)))[0].isDemo).toBe(false);
  });

  it("promotes a hot-first keyword to ordinary research before merging its bounded boost", async () => {
    const phrase = "swiss alps wall art";
    await db.update(keywords).set({ source: "hot:google-trends", demandScore: 0, competitionScore: 0, score: 0.1 })
      .where(eq(keywords.phrase, phrase));
    await runResearch(ctx);
    const [row] = await db.select().from(keywords).where(eq(keywords.phrase, phrase));
    expect(row.source).not.toMatch(/^hot:/);
    expect(row.demandScore).toBeGreaterThan(0);
    expect(row.score).toBeGreaterThan(0.1);
  });
});

it("registers a read-only daily hot stage and CRON_SECRET-only workflow authentication", () => {
  expect(isStage("hot")).toBe(true);
  expect(DEFAULT_STAGES.hot.cron).toBe("40 4 * * *");
  const yaml = readFileSync(new URL("../.github/workflows/autopilot-cron.yml", import.meta.url), "utf8");
  const job = yaml.slice(yaml.indexOf("  hot:"), yaml.indexOf("  analytics:"));
  expect(job).toContain("'Authorization: %s %s' 'Bearer'");
  expect(job).toContain('"${CRON_SECRET}"');
  expect(job).toContain('"${url}/api/cron/hot"');
  expect(yaml).toContain('- cron: "40 4 * * *"');
  expect(yaml).toContain("- hot");
});
