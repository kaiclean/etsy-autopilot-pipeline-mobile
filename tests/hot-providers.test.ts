import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activeNiches } from "@/lib/niches";
import { amazonSource, createAmazonSource, parseAmazonApi, parseAmazonHtml, signAmazonSearch } from "@/pipeline/hot-signals/amazon";
import { createEtsyBadgesSource, etsyBadgesSource, parseEtsyApi, parseEtsyHtml } from "@/pipeline/hot-signals/etsy-badges";
import { AMAZON_POD_PAGES, createHotFetcher, HOT_USER_AGENT, robotsAllows } from "@/pipeline/hot-signals/fetch";
import { createGoogleTrendsSource, googleTrendsSource, rotatedGoogleSeeds } from "@/pipeline/hot-signals/google-trends";
import { decodeHtml, productUrl } from "@/pipeline/hot-signals/html";
import { createPinterestTrendsSource, parsePinterestTrends, pinterestTrendsSource, PINTEREST_GROWING_URL } from "@/pipeline/hot-signals/pinterest-trends";
import { observedScore } from "@/pipeline/hot-signals/types";
import { parseGoogleTrendScore } from "@/pipeline/sources";

const now = new Date("2026-10-10T12:00:00Z");
const options = () => ({ now, demo: false, log: vi.fn() });
const amazonSettings = {
  scrapeEnabled: false,
  amazonMarketplace: "US",
  amazonAccessKey: "fixture-access-key",
  amazonSecretKey: "fixture-secret-key",
  amazonPartnerTag: "fixture-20",
};
const amazonItem = {
  DetailPageURL: "https://www.amazon.com/dp/B000123456?tag=fixture-20",
  ItemInfo: { Title: { DisplayValue: "Swiss Alps Mountain Poster" } },
};
const amazonHtml = `
<h1>Best Sellers, #1 in everything</h1>
<div id="gridItemRoot"><span class="zg-bdg-text">#12</span>
  <a href="/dp/B000123456?ref=zg"><div class="p13n-sc-truncate">Swiss Alps &amp; Mountain Poster</div></a>
</div>
<div id="gridItemRoot">
  <a href="/dp/B000123457"><div class="_cDEzb_p13n-sc-css-line-clamp-3_test">Bestseller Gothic Floral Shirt</div></a>
</div>
<div id="gridItemRoot"><span class="zg-bdg-text">#3</span>
  <a href="https://malicious.invalid/dp/B000123458"><div class="p13n-sc-truncate">Unsafe product</div></a>
</div>`;
const etsyHtml = `
<div class="wt-badge">Bestseller</div><p>100 bought in the last 24 hours</p>
<li data-listing-id="12345"><a href="/listing/12345/swiss-poster?ref=search" title="Swiss Alps Poster">
  <h3 class="v2-listing-card__title">Swiss Alps &amp; Lake Poster</h3>
</a><span class="wt-badge wt-badge--status-02">Bestseller</span>
<span>12 people bought this in the last 24 hours</span></li>
<li data-listing-id="12346"><a href="https://www.etsy.com/listing/12346/gothic"><h3>Bestseller Gothic Floral Shirt</h3></a></li>
<li data-listing-id="12347"><a href="/listing/12347/christmas"><h3>Cozy Christmas Mug</h3></a>
<div class="wt-badge">Etsy's Pick</div><span>25 sales in the last 24 hours</span></li>
<li data-listing-id="12348"><a href="https://malicious.invalid/listing/12348"><h3>Unsafe</h3></a><span class="wt-badge">Bestseller</span></li>`;

function fixtureFetcher(responses: (string | Response)[]) {
  let clock = 1000;
  const times: number[] = [];
  const sleeps: number[] = [];
  const fetchImpl = vi.fn(async () => {
    times.push(clock);
    const response = responses.shift();
    if (response === undefined) throw new Error("Unexpected fixture request with fixture-secret-key");
    return typeof response === "string" ? new Response(response) : response;
  });
  const fetcher = createHotFetcher({
    fetchImpl: fetchImpl as unknown as typeof fetch,
    clock: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
  });
  return { fetcher, fetchImpl, times, sleeps };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Non-fixture network is forbidden"); }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("observed Amazon products", () => {
  it("uses actual product-card rank, title and product link, never page labels or array order", () => {
    const signals = parseAmazonHtml(amazonHtml, { now, category: "Posters & Prints" });
    expect(signals).toHaveLength(2);
    expect(signals[0]).toMatchObject({
      title: "Swiss Alps & Mountain Poster", rank: 12, label_text: "#12", metric: null, badge: null,
      source_url: "https://www.amazon.com/dp/B000123456", category: "Posters & Prints", fetched_at: now,
    });
    expect(signals[1]).toMatchObject({ rank: null, badge: null, label_text: null, metric: null });
    expect(observedScore(signals[1])).toBe(0);
  });

  it("supports comma ranks and legacy cards but rejects malformed or zero ranks", () => {
    const cards = ["#1,234", "#0", "#3,12", "2"].map((rank, index) => `
      <div class="zg-item-immersion"><span class="zg-bdg-text">${rank}</span>
      <a href="/dp/B00012345${index}"><div class="p13n-sc-truncated">Mountain Poster</div></a></div>`).join("");
    expect(parseAmazonHtml(cards, { now, category: "Posters & Prints" }).map((signal) => signal.rank)).toEqual([1234, null, null, null]);
  });

  it("does not attribute wrapper ranks to child product cards", () => {
    const html = `<div class="zg-item-immersion"><span class="zg-bdg-text">#1</span>${amazonHtml}</div>`;
    expect(parseAmazonHtml(html, { now, category: "Posters" }).map((signal) => signal.rank)).toEqual([12, null]);
  });

  it("does not mix multiple product links with a single card's rank", () => {
    const html = `<div id="gridItemRoot"><span class="zg-bdg-text">#1</span>
      <a href="/dp/B000123456"><div class="p13n-sc-truncate">Mountain Poster</div></a>
      <a href="/dp/B000123457">Other product</a></div>`;
    expect(parseAmazonHtml(html, { now, category: "Posters" })).toEqual([]);
  });

  it("ignores unclosed Amazon product cards", () => {
    const html = `<div id="gridItemRoot"><span class="zg-bdg-text">#1</span>
      <a href="/dp/B000123456"><div class="p13n-sc-truncate">Mountain Poster</div></a>`;
    expect(parseAmazonHtml(html, { now, category: "Posters" })).toEqual([]);
  });

  it("uses only PAAPI SalesRank, not result order, reviews, price or title language", () => {
    const data = { SearchResult: { Items: [
      { ...amazonItem, BrowseNodeInfo: { BrowseNodes: [{ DisplayName: "Posters", SalesRank: 7 }] } },
      { ...amazonItem, ItemInfo: { Title: { DisplayValue: "Bestseller Mountain Poster" } }, Offers: { Listings: [{ Price: { Amount: 99 } }] } },
      { ...amazonItem, BrowseNodeInfo: { WebsiteSalesRank: { DisplayName: "Home & Kitchen", SalesRank: 90 } } },
    ] } };
    const signals = parseAmazonApi(data, now);
    expect(signals.map((signal) => signal.rank)).toEqual([7, null, 90]);
    expect(signals.map((signal) => signal.metric)).toEqual([null, null, null]);
    expect(signals.map((signal) => signal.badge)).toEqual([null, null, null]);
    expect(signals[0].category).toBe("Posters");
  });

  it.each([0, -1, 1.5, "3", Infinity, null])("does not coerce invalid API rank %s", (SalesRank) => {
    expect(parseAmazonApi({ SearchResult: { Items: [{ ...amazonItem, BrowseNodeInfo: { BrowseNodes: [{ SalesRank }] } }] } }, now)[0].rank).toBeNull();
  });

  it("rejects untrusted detail URLs and missing titles", () => {
    expect(parseAmazonApi({ SearchResult: { Items: [
      { ...amazonItem, DetailPageURL: "https://evil.invalid/dp/B000123456" },
      { ...amazonItem, ItemInfo: {} },
    ] } }, now)).toEqual([]);
    expect(parseAmazonApi({}, now)).toEqual([]);
  });

  it("creates deterministic PAAPI5 SigV4 headers with a payload-bound signature", () => {
    const credentials = { accessKey: "fixture-access", secretKey: "fixture-secret" };
    const first = signAmazonSearch('{"Keywords":"mountain poster"}', credentials, now);
    expect(first["x-amz-date"]).toBe("20261010T120000Z");
    expect(first["x-amz-target"]).toBe("com.amazon.paapi5.v1.ProductAdvertisingAPIv1.SearchItems");
    expect(first.host).toBe("webservices.amazon.com");
    expect(first.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=fixture-access\/20261010\/us-east-1\/ProductAdvertisingAPI\/aws4_request, SignedHeaders=content-encoding;content-type;host;x-amz-date;x-amz-target, Signature=[a-f0-9]{64}$/);
    expect(first).toEqual(signAmazonSearch('{"Keywords":"mountain poster"}', credentials, now));
    expect(first.authorization).not.toBe(signAmazonSearch('{"Keywords":"christmas mug"}', credentials, now).authorization);
  });
});

describe("observed Etsy listing cards", () => {
  it.each(["3 sold in the last 24 hours", "3 sold in last 24 hours"])("retains exact Etsy sold label %s without inventing a sales metric", (label) => {
    const html = `<li data-listing-id="12345"><a href="/listing/12345"><h3>Swiss Alps Poster</h3></a><span>${label}</span></li>`;
    expect(parseEtsyHtml(html, now)[0]).toMatchObject({ label_text: label, metric: null, rank: null, badge: null });
  });

  it("recognizes scoped badges and preserves last24h label literally without turning it into a metric", () => {
    const signals = parseEtsyHtml(etsyHtml, now);
    expect(signals).toHaveLength(3);
    expect(signals[0]).toMatchObject({
      title: "Swiss Alps & Lake Poster", badge: "Bestseller", label_text: "12 people bought this in the last 24 hours",
      rank: null, metric: null, source_url: "https://www.etsy.com/listing/12345",
    });
    expect(signals[1]).toMatchObject({ badge: null, rank: null, metric: null, label_text: null });
    expect(signals[2]).toMatchObject({ badge: "Etsy's Pick", label_text: "25 sales in the last 24 hours", metric: null });
  });

  it("never treats bestseller in titles, arbitrary text, favorites or a global banner as a badge", () => {
    const html = `<div data-listing-id="789"><a href="/listing/789/test"><h3>Bestseller Mountain Poster</h3></a>
      <p>Bestseller</p><span>20 favorites</span><span class="wt-badge">Popular now</span></div>`;
    expect(parseEtsyHtml(html, now)[0]).toMatchObject({ badge: null, metric: null, label_text: null });
  });

  it("never treats badge-styled titles or their wrappers as sales badges", () => {
    const html = `<div data-listing-id="789"><div class="wt-badge"><a href="/listing/789">
      <h3 class="wt-badge"><span class="wt-badge">Bestseller</span></h3></a></div></div>`;
    expect(parseEtsyHtml(html, now)[0]).toMatchObject({ badge: null, metric: null, label_text: null });
  });

  it("does not mix a mismatched listing's link and badges", () => {
    expect(parseEtsyHtml('<li data-listing-id="789"><a href="/listing/790"><h3>Mountain Poster</h3></a><span class="wt-badge">Bestseller</span></li>', now)).toEqual([]);
    expect(parseEtsyHtml('<li data-listing-id="789"><a href="/listing/789"><h3>Mountain Poster</h3></a><a href="/listing/790">Other listing</a><span class="wt-badge">Bestseller</span></li>', now)).toEqual([]);
    expect(parseEtsyHtml('<li data-listing-id="789"><a href="/listing/789"><h3>Mountain Poster</h3></a><span class="wt-badge">Bestseller</span>', now)).toEqual([]);
  });

  it("does not synthesize API badges, sales, ranks or metrics from score sorting", () => {
    const signals = parseEtsyApi({ count: 200, results: [{
      listing_id: 12345, title: "Bestseller Mountain Poster", url: "https://www.etsy.com/listing/12345/poster",
      num_favorers: 500, views: 1000, rank: 1, score: 99, badge: "Bestseller",
    }] }, now);
    expect(signals[0]).toMatchObject({ rank: null, badge: null, metric: null, label_text: null });
    expect(observedScore(signals[0])).toBe(0);
    expect(parseEtsyApi({ results: [{ title: "Poster", url: "http://www.etsy.com/listing/2" }] }, now)).toEqual([]);
  });
});

describe("official Pinterest trends", () => {
  it("uses only pct_growth_wow numbers, never array order or predictions", () => {
    const signals = parsePinterestTrends({ trends: [
      { keyword: "Alpine Poster", pct_growth_wow: 42 },
      { keyword: "Gothic Floral", pct_growth_wow: null, predictions: [{ value: 99 }], rank: 1 },
      { keyword: "Christmas Mug", pct_growth_wow: "60" },
      { keyword: "Winter Gift", pct_growth_wow: -12 },
    ] }, now);
    expect(signals.map((signal) => signal.metric)).toEqual([42, null, null, -12]);
    expect(signals.every((signal) => signal.rank === null && signal.badge === null)).toBe(true);
    expect(signals.every((signal) => new URL(signal.source_url).origin === "https://trends.pinterest.com")).toBe(true);
    expect(signals.map((signal) => new URL(signal.source_url).searchParams.get("term"))).toEqual(["Alpine Poster", "Gothic Floral", "Christmas Mug", "Winter Gift"]);
    expect(signals.every((signal) => new URL(signal.source_url).searchParams.get("region") === "US")).toBe(true);
    expect(new Set(signals.map((signal) => signal.source_url)).size).toBe(4);
    expect(signals.every((signal) => signal.fetched_at === now)).toBe(true);
    expect(parsePinterestTrends({ keywords: [{ keyword: "wrong shape", pct_growth_wow: 50 }] }, now)).toEqual([]);
    expect(parsePinterestTrends({ trends: [{ keyword: "" }, { keyword: 12 }] }, now)).toEqual([]);
  });

  it("calls the official US growing endpoint with auth and no predicted metric", async () => {
    const fixture = fixtureFetcher([JSON.stringify({ trends: [{ keyword: "mountain poster", pct_growth_wow: 35 }] })]);
    const source = createPinterestTrendsSource({ fetcher: fixture.fetcher, accessToken: () => "fixture-pinterest" });
    expect((await source.collectSignals(options()))[0].metric).toBe(35);
    const [url, init] = fixture.fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe(PINTEREST_GROWING_URL);
    expect(new Headers(init.headers).get("authorization")).toBe(["Bearer", "fixture-pinterest"].join(" "));
    expect(init.redirect).toBe("manual");
  });

  it("retains multiple keyword observations with distinct official human-readable URLs", async () => {
    const fixture = fixtureFetcher([JSON.stringify({ trends: [
      { keyword: "swiss mountain poster", pct_growth_wow: 35 },
      { keyword: "cozy christmas mug", pct_growth_wow: 60 },
    ] })]);
    const signals = await createPinterestTrendsSource({ fetcher: fixture.fetcher, accessToken: () => "fixture-pinterest" }).collectSignals(options());
    expect(signals).toHaveLength(2);
    expect(new Set(signals.map((signal) => signal.source_url)).size).toBe(2);
    expect(signals.map((signal) => new URL(signal.source_url).searchParams.get("term"))).toEqual(["swiss mountain poster", "cozy christmas mug"]);
    expect(signals.map((signal) => signal.rank)).toEqual([null, null]);
  });
});

describe("guarded network access", () => {
  it("makes no requests when scraping is off, even for an unapproved URL", async () => {
    const fixture = fixtureFetcher([]);
    expect(await fixture.fetcher.html("http://127.0.0.1/private", { scrapeEnabled: false, log: vi.fn() })).toBeNull();
    expect(fixture.fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    "http://www.amazon.com/gp/bestsellers/home-garden/381142011",
    "https://www.amazon.com/s?k=poster",
    "https://www.amazon.com/gp/bestsellers",
    "https://www.amazon.com/gp/bestsellers/home-garden/381142011?redirect=evil",
    "https://www.etsy.com/listing/123",
    "https://www.etsy.com/search?q=poster&redirect=evil",
    "https://" + "fixture-user@" + "www.etsy.com/search?q=poster",
    "https://www.etsy.com:8080/search?q=poster",
    "https://www.etsy.com.evil.invalid/search",
  ])("rejects unapproved scraping URL %s without network", async (url) => {
    const fixture = fixtureFetcher([]);
    await expect(fixture.fetcher.html(url, { scrapeEnabled: true, log: vi.fn() })).rejects.toThrow("unapproved");
    expect(fixture.fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects unapproved API endpoints without network", async () => {
    const fixture = fixtureFetcher([]);
    await expect(fixture.fetcher.json("https://api.pinterest.com/v5/user_account", { log: vi.fn() })).rejects.toThrow("unapproved");
    await expect(fixture.fetcher.json("https://127.0.0.1/v3/application/listings/active", { log: vi.fn() })).rejects.toThrow("unapproved");
    expect(fixture.fetchImpl).not.toHaveBeenCalled();
  });

  it("honors robots disallow, caches policy, and never fetches disallowed pages", async () => {
    const fixture = fixtureFetcher(["User-agent: *\nDisallow: /gp/"]);
    const log = vi.fn();
    for (const page of AMAZON_POD_PAGES.slice(0, 2)) {
      expect(await fixture.fetcher.html(`https://www.amazon.com${page.path}`, { scrapeEnabled: true, log })).toBeNull();
    }
    expect(fixture.fetchImpl).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("robots disallows"), "warn");
  });

  it.each([
    new Response("denied fixture-secret-key", { status: 403 }),
    new Response("missing", { status: 404 }),
    new Response("", { status: 200 }),
    new Response("User-agent:\nDisallow: /", { status: 200 }),
    new Response("<html>User-agent: *</html>", { status: 200 }),
  ])("fails closed on unavailable robots", async (response) => {
    const fixture = fixtureFetcher([response]);
    await expect(fixture.fetcher.html(`https://www.amazon.com${AMAZON_POD_PAGES[0].path}`, { scrapeEnabled: true, log: vi.fn() })).rejects.toThrow(/HTTP|robots policy unavailable/);
    expect(fixture.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("identifies crawler, forbids redirects, and spaces robots plus HTML by at least 2 seconds", async () => {
    const fixture = fixtureFetcher(["User-agent: *\nAllow: /", amazonHtml, amazonHtml]);
    for (const page of AMAZON_POD_PAGES.slice(0, 2)) {
      await fixture.fetcher.html(`https://www.amazon.com${page.path}`, { scrapeEnabled: true, log: vi.fn() });
    }
    expect(fixture.times).toEqual([1000, 3000, 5000]);
    for (const call of fixture.fetchImpl.mock.calls) {
      const [, init] = call as unknown as [URL, RequestInit];
      expect(new Headers(init.headers).get("user-agent")).toBe(HOT_USER_AGENT);
      expect(init).toMatchObject({ redirect: "manual", cache: "no-store", signal: expect.any(AbortSignal) });
    }
  });

  it("serializes simultaneous same-host calls and does not delay another host", async () => {
    const fixture = fixtureFetcher(["{}", "{}", "{}"]);
    await Promise.all([
      fixture.fetcher.json(PINTEREST_GROWING_URL, { log: vi.fn() }),
      fixture.fetcher.json(PINTEREST_GROWING_URL, { log: vi.fn() }),
    ]);
    expect(fixture.times).toEqual([1000, 3000]);
    await fixture.fetcher.json("https://openapi.etsy.com/v3/application/listings/active", { log: vi.fn() });
    expect(fixture.sleeps).toEqual([2000]);
  });

  it.each([403, 429, 302])("throws sanitized HTTP %s without leaking response body or following redirects", async (status) => {
    const fixture = fixtureFetcher([new Response("fixture-secret-key", { status })]);
    const log = vi.fn();
    await expect(fixture.fetcher.json(PINTEREST_GROWING_URL, { log })).rejects.toThrow(`api.pinterest.com HTTP ${status}`);
    expect(log).toHaveBeenCalledWith(`Hot signals: api.pinterest.com HTTP ${status}`, "warn");
    expect(JSON.stringify(log.mock.calls)).not.toContain("fixture-secret-key");
    expect(fixture.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sanitizes transport errors and invalid JSON", async () => {
    const fixture = fixtureFetcher([]);
    await expect(fixture.fetcher.json(PINTEREST_GROWING_URL, { log: vi.fn() })).rejects.toThrow("request failed");
    const badJson = fixtureFetcher(["fixture-secret-key"]);
    await expect(badJson.fetcher.json(PINTEREST_GROWING_URL, { log: vi.fn() })).rejects.toThrow("invalid JSON");
  });

  it("cancels oversized chunked responses before reading further chunks", async () => {
    let chunks = 0;
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        chunks++;
        controller.enqueue(new Uint8Array(1_000_001));
      },
      cancel,
    }, { highWaterMark: 0 }));
    const fixture = fixtureFetcher([response]);
    const log = vi.fn();
    await expect(fixture.fetcher.json(PINTEREST_GROWING_URL, { log })).rejects.toThrow("request failed");
    expect(chunks).toBe(2);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("Hot signals: api.pinterest.com request failed", "warn");
  });

  it("decodes UTF-8 split across streaming response chunks", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ trends: [{ keyword: "Alpen café", pct_growth_wow: 35 }] }));
    const marker = bytes.findIndex((byte) => byte === 0xc3);
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, marker + 1));
        controller.enqueue(bytes.slice(marker + 1));
        controller.close();
      },
    }));
    const fixture = fixtureFetcher([response]);
    const body = await fixture.fetcher.json(PINTEREST_GROWING_URL, { log: vi.fn() });
    expect(parsePinterestTrends(body, now)[0].title).toBe("Alpen café");
  });

  it("aborts slow requests under the configured timeout", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("fixture-secret-key timeout")), { once: true });
    }));
    const fetcher = createHotFetcher({ fetchImpl, timeoutMs: 10 });
    await expect(fetcher.json(PINTEREST_GROWING_URL, { log: vi.fn() })).rejects.toThrow("request failed");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("uses specific crawler groups, wildcard paths, longest rules and allow ties", () => {
    const url = new URL("https://www.amazon.com/gp/bestsellers/home-garden/381142011");
    expect(robotsAllows("User-agent: *\nDisallow: /\nUser-agent: EtsyAutopilotHotSignals\nAllow: /gp/", url)).toBe(true);
    expect(robotsAllows("User-agent: *\nAllow: /gp/\nDisallow: /gp/bestsellers/*", url)).toBe(false);
    expect(robotsAllows("User-agent: *\nDisallow: /gp/\nAllow: /gp/", url)).toBe(true);
    expect(robotsAllows("User-agent: *\nDisallow: /gp/$", url)).toBe(true);
    expect(robotsAllows("User-agent: *\nAllow: /\nUser-agent: HotSignals\nDisallow: /gp/", url)).toBe(false);
  });
});

describe("provider controls and failure propagation", () => {
  it("has no network at all in demo, even with all credentials and scrape enabled", async () => {
    const fetchImpl = vi.fn(() => { throw new Error("Network forbidden in demo"); });
    vi.stubGlobal("fetch", fetchImpl);
    const sourceOptions = { ...options(), demo: true };
    for (const source of [amazonSource, etsyBadgesSource, googleTrendsSource, pinterestTrendsSource]) {
      expect(await source.collectSignals(sourceOptions)).toEqual([]);
    }
    const fixture = fixtureFetcher([]);
    expect(await createAmazonSource({ settings: () => ({ ...amazonSettings, scrapeEnabled: true }), fetcher: fixture.fetcher }).collectSignals(sourceOptions)).toEqual([]);
    expect(await createEtsyBadgesSource({ apiKey: () => "fixture", scrapeEnabled: () => true, fetcher: fixture.fetcher }).collectSignals(sourceOptions)).toEqual([]);
    const score = vi.fn();
    expect(await createGoogleTrendsSource({ enabled: () => true, score }).collectSignals(sourceOptions)).toEqual([]);
    expect(await createPinterestTrendsSource({ accessToken: () => "fixture", fetcher: fixture.fetcher }).collectSignals(sourceOptions)).toEqual([]);
    expect(score).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fixture.fetchImpl).not.toHaveBeenCalled();
  });

  it("makes no unconfigured Amazon, Etsy or Pinterest requests and skips unsupported marketplace", async () => {
    const fixture = fixtureFetcher([]);
    expect(await createAmazonSource({ settings: () => ({ scrapeEnabled: false, amazonMarketplace: "US" }), fetcher: fixture.fetcher }).collectSignals(options())).toEqual([]);
    expect(await createAmazonSource({ settings: () => ({ ...amazonSettings, amazonMarketplace: "https://evil.invalid", scrapeEnabled: true }), fetcher: fixture.fetcher }).collectSignals(options())).toEqual([]);
    expect(await createEtsyBadgesSource({ apiKey: () => undefined, scrapeEnabled: () => false, fetcher: fixture.fetcher }).collectSignals(options())).toEqual([]);
    expect(await createPinterestTrendsSource({ accessToken: () => undefined, fetcher: fixture.fetcher }).collectSignals(options())).toEqual([]);
    expect(fixture.fetchImpl).not.toHaveBeenCalled();
  });

  it("sends PAAPI5 home/kitchen or apparel requests for active POD niches with actual ranks only", async () => {
    const fixture = fixtureFetcher(Array.from({ length: 3 }, () => JSON.stringify({ SearchResult: { Items: [amazonItem] } })));
    const signals = await createAmazonSource({ settings: () => amazonSettings, fetcher: fixture.fetcher }).collectSignals(options());
    expect(signals).toHaveLength(3);
    expect(signals.every((signal) => signal.rank === null)).toBe(true);
    expect(fixture.times).toEqual([1000, 3000, 5000]);
    for (const call of fixture.fetchImpl.mock.calls) {
      const [url, init] = call as unknown as [URL, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(url.toString()).toBe("https://webservices.amazon.com/paapi5/searchitems");
      expect(body).toMatchObject({ PartnerType: "Associates", Marketplace: "www.amazon.com", PartnerTag: "fixture-20" });
      expect(["HomeAndKitchen", "Apparel"]).toContain(body.SearchIndex);
      expect(body.Resources).toEqual(["ItemInfo.Title", "BrowseNodeInfo.BrowseNodes", "BrowseNodeInfo.BrowseNodes.SalesRank", "BrowseNodeInfo.WebsiteSalesRank"]);
      expect(new Headers(init.headers).get("authorization")).toContain("AWS4-HMAC-SHA256");
    }
  });

  it("does not fall back to scraping on PAAPI failure or scrape when flag is off", async () => {
    const fixture = fixtureFetcher([new Response("fixture-secret-key", { status: 429 })]);
    const source = createAmazonSource({ settings: () => ({ ...amazonSettings, scrapeEnabled: true }), fetcher: fixture.fetcher });
    await expect(source.collectSignals(options())).rejects.toThrow("HTTP 429");
    expect(fixture.fetchImpl).toHaveBeenCalledTimes(1);
    const denied = fixtureFetcher([JSON.stringify({ Errors: [{ Message: "fixture-secret-key" }] })]);
    await expect(createAmazonSource({ settings: () => amazonSettings, fetcher: denied.fetcher }).collectSignals(options())).rejects.toThrow("API rejected SearchItems");
    expect(denied.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not scrape with complete PAAPI credentials even when scraping is enabled", async () => {
    const fixture = fixtureFetcher(Array.from({ length: 3 }, () => JSON.stringify({ SearchResult: { Items: [amazonItem] } })));
    const signals = await createAmazonSource({ settings: () => ({ ...amazonSettings, scrapeEnabled: true }), fetcher: fixture.fetcher }).collectSignals(options());
    expect(signals).toHaveLength(3);
    expect(fixture.fetchImpl).toHaveBeenCalledTimes(3);
    expect(fixture.fetchImpl.mock.calls.every((call) => (call as unknown as [URL])[0].hostname === "webservices.amazon.com")).toBe(true);
  });

  it("only scrapes allowlisted POD best sellers / movers pages after robots allows", async () => {
    const fixture = fixtureFetcher(["User-agent: *\nAllow: /", ...AMAZON_POD_PAGES.map(() => amazonHtml)]);
    const signals = await createAmazonSource({ settings: () => ({ scrapeEnabled: true, amazonMarketplace: "US" }), fetcher: fixture.fetcher }).collectSignals(options());
    expect(signals).toHaveLength(8);
    const urls = fixture.fetchImpl.mock.calls.map((call) => (call as unknown as [URL])[0].pathname);
    expect(urls).toEqual(["/robots.txt", ...AMAZON_POD_PAGES.map((page) => page.path)]);
    expect(fixture.times).toEqual([1000, 3000, 5000, 7000, 9000]);
  });

  it.each(["amazon", "etsy"])("stops %s HTML collection on HTTP 403 after an allowed robots policy", async (provider) => {
    const fixture = fixtureFetcher(["User-agent: *\nAllow: /", new Response("fixture-secret-key", { status: 403 })]);
    const source = provider === "amazon"
      ? createAmazonSource({ settings: () => ({ scrapeEnabled: true, amazonMarketplace: "US" }), fetcher: fixture.fetcher })
      : createEtsyBadgesSource({ apiKey: () => undefined, scrapeEnabled: () => true, fetcher: fixture.fetcher });
    await expect(source.collectSignals(options())).rejects.toThrow("HTTP 403");
    expect(fixture.fetchImpl).toHaveBeenCalledTimes(2);
    expect(fixture.times).toEqual([1000, 3000]);
  });

  it("queries Etsy's official active-listing API sorted by score without treating order as a sales badge", async () => {
    const listing = { title: "Mountain Poster", url: "https://www.etsy.com/listing/12345" };
    const fixture = fixtureFetcher(Array.from({ length: 3 }, () => JSON.stringify({ results: [listing] })));
    const signals = await createEtsyBadgesSource({ apiKey: () => "fixture-key", scrapeEnabled: () => false, fetcher: fixture.fetcher }).collectSignals(options());
    expect(signals).toHaveLength(3);
    expect(signals.every((signal) => signal.rank === null && signal.badge === null && signal.metric === null)).toBe(true);
    for (const call of fixture.fetchImpl.mock.calls) {
      const [url, init] = call as unknown as [URL, RequestInit];
      expect(url.origin + url.pathname).toBe("https://openapi.etsy.com/v3/application/listings/active");
      expect(url.searchParams.get("sort_on")).toBe("score");
      expect(url.searchParams.get("sort_order")).toBe("desc");
      expect(new Headers(init.headers).get("x-api-key")).toBe("fixture-key");
    }
  });

  it("Etsy HTML remains off by default and robots disallow does not fetch search results", async () => {
    const fixture = fixtureFetcher(["User-agent: *\nDisallow: /search"]);
    expect(await createEtsyBadgesSource({ apiKey: () => undefined, scrapeEnabled: () => true, fetcher: fixture.fetcher }).collectSignals(options())).toEqual([]);
    expect(fixture.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(["etsy", "pinterest"])("%s propagates a blocking provider failure without another request", async (provider) => {
    const fixture = fixtureFetcher([new Response("fixture-secret-key", { status: 403 })]);
    const source = provider === "etsy"
      ? createEtsyBadgesSource({ apiKey: () => "fixture", scrapeEnabled: () => true, fetcher: fixture.fetcher })
      : createPinterestTrendsSource({ accessToken: () => "fixture", fetcher: fixture.fetcher });
    await expect(source.collectSignals(options())).rejects.toThrow("HTTP 403");
    expect(fixture.fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("Google Trends budget", () => {
  it("scores genuine numeric Google timeline observations without defaulting absent values to zero", () => {
    const raw = JSON.stringify({ default: { timelineData: [25, 50, 75, 100].map((value) => ({ value: [value] })) } });
    expect(parseGoogleTrendScore(raw)).toBe(0.57);
    expect(parseGoogleTrendScore(JSON.stringify({ default: { timelineData: Array.from({ length: 4 }, () => ({ value: [0] })) } }))).toBe(0);
  });

  it.each([undefined, null, "50", -1, 101, {}, []])("rejects absent or nonnumeric Google observation %s", (value) => {
    const timelineData = [{ value: [25] }, { value: [50] }, { value: [75] }, { value: [value] }];
    expect(parseGoogleTrendScore(JSON.stringify({ default: { timelineData } }))).toBeNull();
  });

  it("rejects missing arrays, short timelines, malformed JSON and invalid additional numeric fields", () => {
    for (const timelineData of [
      [{ value: [25] }, { value: [50] }, { value: [75] }, {}],
      [{ value: [25] }, { value: [50] }, { value: [75] }, { value: [] }],
      [{ value: [25] }, { value: [50] }, { value: [75] }],
      [{ value: [25] }, { value: [50] }, { value: [75] }, { value: [50, "invalid"] }],
    ]) {
      expect(parseGoogleTrendScore(JSON.stringify({ default: { timelineData } }))).toBeNull();
    }
    expect(parseGoogleTrendScore("not json")).toBeNull();
    expect(parseGoogleTrendScore("null")).toBeNull();
    expect(parseGoogleTrendScore("{}")).toBeNull();
  });

  it("rotates five active seed phrases by UTC day and excludes paused niches", () => {
    const seeds = rotatedGoogleSeeds(now);
    const active = new Set(activeNiches().flatMap((niche) => niche.seeds.map((seed) => seed.phrase)));
    expect(seeds).toHaveLength(5);
    expect(new Set(seeds).size).toBe(5);
    expect(seeds.every((seed) => active.has(seed))).toBe(true);
    expect(seeds).not.toEqual(rotatedGoogleSeeds(new Date(now.getTime() + 864e5)));
  });

  it("respects enabled config and collects only actual scores, never popularity ranks", async () => {
    const score = vi.fn(async () => 0.75);
    const waitForHost = vi.fn(async () => {});
    const source = createGoogleTrendsSource({ enabled: () => false, score, waitForHost });
    expect(await source.collectSignals(options())).toEqual([]);
    expect(score).not.toHaveBeenCalled();
    const signals = await createGoogleTrendsSource({ enabled: () => true, score, waitForHost }).collectSignals(options());
    expect(score).toHaveBeenCalledTimes(5);
    expect(waitForHost).toHaveBeenCalledTimes(5);
    expect(signals.every((signal) => signal.rank === null && signal.metric === 0.75 && signal.badge === null)).toBe(true);
    expect(signals.every((signal) => new URL(signal.source_url).hostname === "trends.google.com")).toBe(true);
  });

  it("stops with warning immediately on a null score and preserves earlier observed scores", async () => {
    const score = vi.fn().mockResolvedValueOnce(0.6).mockResolvedValueOnce(null).mockResolvedValue(0.8);
    const opts = options();
    const signals = await createGoogleTrendsSource({ enabled: () => true, score, waitForHost: async () => {} }).collectSignals(opts);
    expect(signals).toHaveLength(1);
    expect(score).toHaveBeenCalledTimes(2);
    expect(opts.log).toHaveBeenCalledWith(expect.stringContaining("stopping provider"), "warn");
  });

  it("stops on thrown scorer error or non-finite metric without leaking error details", async () => {
    for (const score of [vi.fn().mockRejectedValue(new Error("fixture-secret-key")), vi.fn().mockResolvedValue(NaN)]) {
      const opts = options();
      expect(await createGoogleTrendsSource({ enabled: () => true, score, waitForHost: async () => {} }).collectSignals(opts)).toEqual([]);
      expect(score).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(opts.log.mock.calls)).not.toContain("fixture-secret-key");
    }
  });
});

describe("safe product URL and text parsing", () => {
  it("canonicalizes legitimate product links and rejects SSRF and untrusted hosts", () => {
    expect(productUrl("/thing/dp/B000123456?ref=search", "amazon")).toBe("https://www.amazon.com/dp/B000123456");
    expect(productUrl("/de/listing/12345/name", "etsy")).toBe("https://www.etsy.com/listing/12345");
    for (const url of ["javascript:alert(1)", "http://www.amazon.com/dp/B000123456", "//evil.invalid/dp/B000123456", "https://www.amazon.com.evil.invalid/dp/B000123456", "https://user@www.amazon.com/dp/B000123456", "https://www.amazon.com:8080/dp/B000123456", "/dp/invalid", "/gp/product/B000123456"]) {
      expect(productUrl(url, "amazon")).toBeNull();
    }
  });

  it("decodes literal HTML entities without interpreting scripts", () => {
    expect(decodeHtml("Alps &amp; &#x26; &#38; &quot;Art&quot;")).toBe('Alps & & & "Art"');
    expect(decodeHtml("&#99999999;")).toBe("&#99999999;");
    const html = `<script>${amazonHtml}</script>${amazonHtml}`;
    expect(parseAmazonHtml(html, { now, category: "Posters" })).toHaveLength(2);
  });
});
