import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import { hotSignals } from "@/db/schema";
import { HotTodayCard, safeHotSourceUrl, type HotTodayItem } from "@/components/hot-today-card";
import { getHotSignalsToday, hotSignalsTodayQuery } from "@/lib/queries";

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), resolveRequestShop: vi.fn() }));
vi.mock("@/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/lib/shops", () => ({ resolveRequestShop: mocks.resolveRequestShop }));

const SHOP = "11111111-1111-4111-8111-111111111111";
const OTHER_SHOP = "22222222-2222-4222-8222-222222222222";
const now = new Date("2026-10-10T22:30:00Z"); // 11 October in Zurich.
const observedDay = "2026-10-11";

function item(patch: Partial<HotTodayItem> = {}): HotTodayItem {
  return {
    phrase: "alpine mountain poster",
    score: 0.5,
    providers: [{
      provider: "amazon", rank: null, badge: null, labelText: null, metric: null,
      sourceUrl: "https://www.amazon.com/gp/bestsellers/arts-crafts",
      fetchedAt: new Date("2026-10-10T22:15:00Z"),
    }],
    ...patch,
  };
}

function render(items: HotTodayItem[], demo = false) {
  return renderToStaticMarkup(createElement(HotTodayCard, { items, demo, observedDay }));
}

describe("hot today card", () => {
  it("renders only observed evidence, unknown values as em dashes, and the Zurich timestamp", () => {
    const html = render([item()]);
    expect(html).toContain("Top 10 today");
    expect(html).toContain("2026-10-11");
    expect(html).toContain("Rank —");
    expect(html).toContain("Badge —");
    expect(html).toContain("Label —");
    expect(html).toContain("Metric —");
    expect(html).toContain("24h sales: —");
    expect(html).toContain("Sales counts unavailable");
    expect(html).toContain("11 Oct 2026, 00:15");
    expect(html).toMatch(/datetime="2026-10-10T22:15:00.000Z"/i);
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
    expect(html).not.toContain("Demo fixture");
  });

  it("preserves source-specific rank, label, badge and metric without turning them into sales", () => {
    const entry = item();
    entry.providers[0] = { ...entry.providers[0], rank: 7, badge: "Bestseller", labelText: "Observed category rank", metric: 0 };
    entry.providers.push({
      provider: "google-trends", rank: null, badge: null, labelText: "Relative search interest", metric: 0.8,
      sourceUrl: "https://trends.google.com/trends/explore?q=alpine",
      fetchedAt: null,
    });
    const html = render([entry]);
    expect(html.match(/<h3\b/g)).toHaveLength(1);
    expect(html).toContain("Amazon");
    expect(html).toContain("Google Trends");
    expect(html).toContain("Rank 7");
    expect(html).toContain("Badge Bestseller");
    expect(html).toContain("Label Observed category rank");
    expect(html).toContain("Metric 0");
    expect(html).toContain("Metric 0.8");
    expect(html).toContain("Observed —");
    expect(html).not.toMatch(/24h sales: [0-9]/);
  });

  it("labels demo fixtures as non-live, without a fabricated observation or sales count", () => {
    const entry = item();
    entry.providers[0].sourceUrl = "https://example.invalid/hot/alpine";
    const html = render([entry], true);
    expect(html).toContain("Demo fixture — not live demand");
    expect(html).toContain("Fixture — no live observation");
    expect(html).toContain('href="https://example.invalid/hot/alpine"');
    expect(html).not.toContain("<time");
    expect(html).not.toMatch(/24h sales: [0-9]/);
    expect(render([entry])).not.toContain('href="https://example.invalid');
  });

  it("has a truthful empty state and caps the visible list at ten", () => {
    expect(render([])).toContain("No observed signals today");
    const html = render(Array.from({ length: 12 }, (_, index) => item({ phrase: `alpine poster ${index}` })));
    expect(html.match(/<h3\b/g)).toHaveLength(10);
    expect(html).not.toContain("alpine poster 10");
  });

  it("does not render invalid numeric values or timestamps as observed facts", () => {
    const entry = item();
    entry.providers[0] = { ...entry.providers[0], rank: NaN, metric: Infinity, fetchedAt: "invalid" };
    const html = render([entry]);
    expect(html).toContain("Rank —");
    expect(html).toContain("Metric —");
    expect(html).toContain("Observed —");
    expect(html).not.toMatch(/NaN|Infinity|Invalid Date/);
  });

  it.each([
    "javascript:alert(1)",
    "http://www.amazon.com/gp/bestsellers",
    "https://amazon.com.attacker.example/gp/bestsellers",
    "https://www.amazon.com@attacker.example/",
    "******www.amazon.com/",
    "https://www.amazon.com:444/",
    "https://example.invalid/hot/alpine",
    "https://www.etsy.com/listing/123",
  ])("does not link unsafe or mismatched Amazon evidence: %s", (url) => {
    expect(safeHotSourceUrl(url, "amazon")).toBeNull();
    const entry = item();
    entry.providers[0].sourceUrl = url;
    expect(render([entry])).not.toContain('href="');
  });

  it("accepts HTTPS official provider evidence and only explicit invalid-domain demo links", () => {
    expect(safeHotSourceUrl("https://www.amazon.de/gp/bestsellers", "amazon")).toBeTruthy();
    expect(safeHotSourceUrl("https://www.etsy.com/listing/123", "etsy")).toBeTruthy();
    expect(safeHotSourceUrl("https://trends.google.com/trends/explore", "google-trends")).toBeTruthy();
    expect(safeHotSourceUrl("https://trends.pinterest.com/", "pinterest")).toBeTruthy();
    expect(safeHotSourceUrl("https://example.invalid/hot/alpine", "etsy", true)).toBeTruthy();
    expect(safeHotSourceUrl("https://example.invalid/other", "etsy", true)).toBeNull();
  });
});

describe("hot today query", () => {
  let client: PGlite;
  let db: DB;

  beforeAll(async () => {
    client = new PGlite("memory://");
    db = drizzle(client) as unknown as DB;
    await db.execute(sql`
      CREATE TABLE hot_signals (
        id serial PRIMARY KEY, shop_id uuid, provider text NOT NULL, category text,
        title text NOT NULL, phrase text NOT NULL, niche text, rank integer,
        badge text, label_text text, metric double precision, score double precision NOT NULL DEFAULT 0,
        source_url text NOT NULL, fetched_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await client.close();
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE hot_signals`);
    mocks.getDb.mockResolvedValue(db);
    mocks.resolveRequestShop.mockResolvedValue({ id: SHOP });
    vi.stubEnv("DEMO_MODE", "false");
  });

  async function seed(patch: Partial<typeof hotSignals.$inferInsert> = {}) {
    await db.insert(hotSignals).values({
      shopId: SHOP, provider: "amazon", category: "Wall art", title: "Alpine mountain poster",
      phrase: "alpine mountain poster", rank: 3, badge: null, labelText: "Category rank", metric: null,
      score: 0.3, sourceUrl: "https://www.amazon.com/gp/bestsellers/arts-crafts",
      fetchedAt: new Date("2026-10-10T22:15:00Z"), ...patch,
    });
  }

  it("uses an explicit scalar projection with active-shop and Zurich-date predicates", () => {
    const query = hotSignalsTodayQuery(db, SHOP, now).toSQL();
    expect(query.sql).toContain("AT TIME ZONE 'Europe/Zurich'");
    expect(query.params).toContain(SHOP);
    expect(query.params).toContain(observedDay);
    expect(query.sql.split(" from ")[0]).not.toMatch(/shop_id|created_at|score|niche/);
    expect(query.sql).not.toContain("*");
  });

  it("groups normalized phrases across providers and retains each provider's source evidence", async () => {
    await seed({ phrase: "  ALPINE   mountain poster  " });
    await seed({
      provider: "etsy", phrase: "alpine mountain poster", rank: null, badge: "Bestseller",
      labelText: "Bestseller badge", sourceUrl: "https://www.etsy.com/listing/123",
    });
    const result = await getHotSignalsToday(now);
    expect(result.demo).toBe(false);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].phrase).toBe("alpine mountain poster");
    expect(result.items[0].providers).toHaveLength(2);
    expect(result.items[0].providers.map((evidence) => evidence.provider).sort()).toEqual(["amazon", "etsy"]);
    expect(result.items[0].providers.find((evidence) => evidence.provider === "etsy")).toMatchObject({
      rank: null, badge: "Bestseller", labelText: "Bestseller badge", metric: null,
      sourceUrl: "https://www.etsy.com/listing/123",
    });
    expect(mocks.resolveRequestShop).toHaveBeenCalledWith(db);
  });

  it("does not surface invalid provider links or unknown providers as live evidence", async () => {
    await seed({ sourceUrl: "https://amazon.com.attacker.example/dp/alpine" });
    await seed({ sourceUrl: "http://www.amazon.com/dp/alpine" });
    await seed({ provider: "unknown", sourceUrl: "https://www.amazon.com/dp/alpine" });
    const result = await getHotSignalsToday(now);
    expect(result.items).toEqual([]);
    expect(result.demo).toBe(false);
  });

  it("includes shared public observations without treating null-shop demo fixtures as live", async () => {
    await seed({ shopId: null, phrase: "alpine public poster" });
    await seed({ shopId: null, sourceUrl: "https://example.invalid/hot/alpine", phrase: "alpine fixture poster" });
    const result = await getHotSignalsToday(now);
    expect(result.items.map((entry) => entry.phrase)).toEqual(["alpine public poster"]);
    expect(result.demo).toBe(false);
  });

  it("excludes yesterday's still-fresh cache, future observations, another shop and null-shop fixtures", async () => {
    await seed({ phrase: "alpine yesterday poster", fetchedAt: new Date("2026-10-10T21:59:59Z") });
    await seed({ phrase: "alpine future poster", fetchedAt: new Date("2026-10-10T22:31:00Z") });
    await seed({ shopId: OTHER_SHOP, phrase: "alpine other poster" });
    await seed({ shopId: null, sourceUrl: "https://example.invalid/hot/alpine", phrase: "alpine fixture poster" });
    await seed({ sourceUrl: "https://example.invalid/hot/alpine", phrase: "alpine scoped fixture poster" });
    await seed({ phrase: "alpine current poster", fetchedAt: new Date("2026-10-10T22:00:00Z") });
    const result = await getHotSignalsToday(now);
    expect(result.items.map((entry) => entry.phrase)).toEqual(["alpine current poster"]);
    expect(result.observedDay).toBe(observedDay);
  });

  it.each([
    { at: "2026-03-29T12:00:00Z", day: "2026-03-29", start: "2026-03-28T23:00:00Z", previous: "2026-03-28T22:59:59Z" },
    { at: "2026-10-25T12:00:00Z", day: "2026-10-25", start: "2026-10-24T22:00:00Z", previous: "2026-10-24T21:59:59Z" },
  ])("handles Zurich daylight-saving boundaries for $day", async ({ at, day, start, previous }) => {
    await seed({ phrase: "alpine current poster", fetchedAt: new Date(start) });
    await seed({ phrase: "alpine yesterday poster", fetchedAt: new Date(previous) });
    const result = await getHotSignalsToday(new Date(at));
    expect(result.observedDay).toBe(day);
    expect(result.items.map((entry) => entry.phrase)).toEqual(["alpine current poster"]);
  });

  it("shows fixtures only in demo mode with no real observations and never mixes them into live evidence", async () => {
    expect((await getHotSignalsToday(now)).items).toEqual([]);
    vi.stubEnv("DEMO_MODE", "true");
    const fixture = await getHotSignalsToday(now);
    expect(fixture.demo).toBe(true);
    expect(fixture.items).toHaveLength(2);
    expect(fixture.items.every((entry) => entry.providers.every((evidence) => evidence.fetchedAt === null))).toBe(true);
    expect(render(fixture.items, fixture.demo)).toContain("Demo fixture — not live demand");
    await seed();
    const live = await getHotSignalsToday(now);
    expect(live.demo).toBe(false);
    expect(live.items).toHaveLength(1);
    expect(live.items.flatMap((entry) => entry.providers).some((evidence) => evidence.sourceUrl.includes("example.invalid"))).toBe(false);
  });

  it("ranks observed signals into at most ten phrase groups", async () => {
    for (let index = 1; index <= 12; index++) {
      await seed({ phrase: `alpine mountain poster ${index}`, rank: index, sourceUrl: `https://www.amazon.com/dp/alpine-${index}` });
    }
    const result = await getHotSignalsToday(now);
    expect(result.items).toHaveLength(10);
    expect(result.items[0].phrase).toBe("alpine mountain poster 1");
    expect(result.items[9].phrase).toBe("alpine mountain poster 10");
  });
});
