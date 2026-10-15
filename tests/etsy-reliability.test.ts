import { afterEach, describe, expect, it, vi } from "vitest";
import { EtsyLiveClient } from "@/adapters/etsy/client";
import { EtsyAmbiguousWriteError, etsyRequest, officialEtsyUrl } from "@/adapters/etsy/transport";
import { etsyMoneyInChf, validateEtsyMoney } from "@/adapters/etsy/money";
import { findSellerTaxonomy, validateVariationScales } from "@/adapters/etsy/taxonomy";
import type { EtsyTokens } from "@/lib/settings";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const json = (value: unknown, init?: ResponseInit) => new Response(JSON.stringify(value), init);
const tokens = (): EtsyTokens => ({ accessToken: "123.access", refreshToken: "123.refresh", expiresAt: Date.now() + 3600_000, userId: "123" });
const client = () => new EtsyLiveClient(tokens(), async () => {}, "123");
const receipt = (id: number, extra = {}) => ({
  receipt_id: id, created_timestamp: 1_790_000_000, updated_timestamp: 1_790_100_000,
  is_paid: true, is_canceled: false, country_iso: "CH",
  transactions: [{ transaction_id: id, listing_id: 456, quantity: 2, price: { amount: 1250, divisor: 100, currency_code: "CHF" } }],
  ...extra,
});

describe("shared Etsy request safety", () => {
  it.each([
    "http://openapi.etsy.com/v3/application/listings",
    "https://openapi.etsy.com.evil.invalid/v3/application/listings",
    "https://user@openapi.etsy.com/v3/application/listings",
    "https://openapi.etsy.com/v3/public/oauth/token",
    "https://openapi.etsy.com/v3/application/%2e%2e/other",
  ])("rejects unsafe resource %s", (url) => {
    expect(() => officialEtsyUrl(url)).toThrow();
  });

  it("bounds read retries, honors Retry-After, and redacts provider bodies", async () => {
    let time = 0;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ secret: "do-not-log" }, { status: 429, headers: { "retry-after": "2" } }))
      .mockResolvedValueOnce(json({ secret: "do-not-log" }, { status: 503 }))
      .mockResolvedValueOnce(json({ count: 7 }));
    const sleep = vi.fn(async (ms: number) => { time += ms; });
    expect(await etsyRequest("/v3/application/listings/active", {}, {
      apiKey: "retry-fixture", fetchImpl, sleep, now: () => time,
    })).toEqual({ count: 7 });
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([2000, 500]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: "error", cache: "no-store", signal: expect.any(AbortSignal) });
  });

  it.each([429, 500, 503])("never retries writes after HTTP %s", async (status) => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ secret: "do-not-log" }, { status }));
    await expect(etsyRequest("/v3/application/shops/123/listings", { method: "POST" }, {
      apiKey: `write-${status}`, fetchImpl,
    })).rejects.toThrow(status === 429 ? `Etsy API HTTP ${status}` : "outcome is unknown");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("holds interrupted and unreadable write outcomes without retrying", async () => {
    for (const fetchImpl of [
      vi.fn().mockRejectedValue(new Error("private network message")),
      vi.fn().mockResolvedValue(new Response("not json")),
    ]) {
      await expect(etsyRequest("/v3/application/shops/123/listings", { method: "POST" }, {
        apiKey: "ambiguous-write", fetchImpl,
      })).rejects.toBeInstanceOf(EtsyAmbiguousWriteError);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("reserves low daily quota for operations and stops long cooldowns immediately", async () => {
    const fetchImpl = vi.fn(async () => json({ count: 0 }, { headers: { "x-remaining-today": "10" } }));
    await etsyRequest("/v3/application/listings/active", {}, { apiKey: "quota-fixture", fetchImpl });
    await expect(etsyRequest("/v3/application/listings/active", {}, { apiKey: "quota-fixture", priority: "research", fetchImpl }))
      .rejects.toThrow("reserve API quota");
    await etsyRequest("/v3/application/shops/123/receipts", {}, { apiKey: "quota-fixture", fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const blocked = vi.fn().mockResolvedValue(json({}, { status: 429, headers: { "retry-after": "300" } }));
    await expect(etsyRequest("/v3/application/listings/active", {}, { apiKey: "blocked-fixture", fetchImpl: blocked })).rejects.toThrow("cooldown");
    expect(blocked).toHaveBeenCalledTimes(1);
  });
});

describe("validated taxonomy mappings", () => {
  const input = { title: "Example", description: "Example", priceChf: 8, tags: ["example"], type: "download" as const };

  it("requires an explicit existing leaf taxonomy before sending a draft write", async () => {
    vi.stubEnv("ETSY_TAXONOMY_ID_DIGITAL", "");
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    await expect(client().createDraftListing(input)).rejects.toThrow("explicitly select");
    expect(fetchImpl).not.toHaveBeenCalled();
    vi.stubEnv("ETSY_TAXONOMY_ID_DIGITAL", "1");
    fetchImpl.mockResolvedValue(json({ results: [{ id: 1, parent_id: null, children: [{ id: 2, parent_id: 1 }] }] }));
    await expect(client().createDraftListing(input)).rejects.toThrow("leaf");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("uses the reviewed taxonomy and rejects a successful write without a valid provider id", async () => {
    vi.stubEnv("ETSY_TAXONOMY_ID_DIGITAL", "2");
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ results: [{ id: 1, parent_id: null, children: [{ id: 2, parent_id: 1 }] }] }))
      .mockResolvedValueOnce(json({ shop_id: 123, currency_code: "CHF" }))
      .mockResolvedValueOnce(json({}));
    vi.stubGlobal("fetch", fetchImpl);
    await expect(client().createDraftListing(input)).rejects.toBeInstanceOf(EtsyAmbiguousWriteError);
    expect(new URLSearchParams(fetchImpl.mock.calls[2][1].body).get("taxonomy_id")).toBe("2");
    expect(findSellerTaxonomy([{ id: 1, parent_id: null, children: [{ id: 2, parent_id: 1 }] }], 2)?.id).toBe(2);
  });

  it("does not submit CHF prices to a foreign-currency shop", async () => {
    vi.stubEnv("ETSY_TAXONOMY_ID_DIGITAL", "2");
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ results: [{ id: 2, parent_id: null }] }))
      .mockResolvedValueOnce(json({ shop_id: 123, currency_code: "USD" }));
    vi.stubGlobal("fetch", fetchImpl);
    await expect(client().createDraftListing(input)).rejects.toThrow("verified CHF");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects unsupported properties, invalid values, and inconsistent inventory scales", () => {
    const properties = [{ property_id: 7, supports_variations: true, scales: [{ scale_id: 1 }, { scale_id: 2 }], possible_values: [{ value_id: 3 }] }];
    expect(() => validateVariationScales([{ propertyValues: [{ propertyId: 7 }] }], properties)).toThrow("scale");
    expect(() => validateVariationScales([
      { propertyValues: [{ propertyId: 7, scaleId: 1 }] }, { propertyValues: [{ propertyId: 7, scaleId: 2 }] },
    ], properties)).toThrow("consistent");
    expect(() => validateVariationScales([{ propertyValues: [{ propertyId: 7, scaleId: 1, valueIds: [99] }] }], properties)).toThrow("value");
    expect(() => validateVariationScales([{ propertyValues: [{ propertyId: 8, scaleId: 1 }] }], properties)).toThrow("not supported");
  });
});

describe("complete receipt ingestion contracts", () => {
  it("paginates by updated time and preserves original money and timestamps", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ count: 101, results: Array.from({ length: 100 }, (_, i) => receipt(i + 1)) }))
      .mockResolvedValueOnce(json({ count: 101, results: [receipt(101)] }));
    vi.stubGlobal("fetch", fetchImpl);
    const result = await client().getReceipts({ since: new Date("2026-10-01T00:00:00Z") });
    expect(result).toHaveLength(101);
    expect(result[100]).toMatchObject({
      receiptId: "101-101", totalChf: 25, paid: true,
      originalMoney: { amount: 1250, divisor: 100, currency_code: "CHF" }, fxRate: 1,
      modifiedAt: new Date(1_790_100_000_000),
    });
    const urls = fetchImpl.mock.calls.map(([url]) => new URL(url));
    expect(urls[0].searchParams.get("min_last_modified")).toBe("1790812800");
    expect(urls[0].searchParams.get("was_paid")).toBeNull();
    expect(urls[1].searchParams.get("offset")).toBe("100");
    expect(urls[0].searchParams.get("sort_on")).toBe("updated");
  });

  it("fails incomplete pagination instead of accepting a partial batch", async () => {
    const rows = Array.from({ length: 100 }, (_, i) => receipt(i + 1));
    vi.stubGlobal("fetch", vi.fn(async () => json({ count: 200, results: rows })));
    await expect(client().getReceipts({ since: new Date(0) })).rejects.toThrow("pagination did not advance");
  });

  it("does not guess missing money or silently label a foreign amount CHF", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ results: [receipt(1, {
      transactions: [{ transaction_id: 1, listing_id: 456, quantity: 1, price: { amount: 1250 } }],
    })] })));
    await expect(client().getReceipts({ since: new Date(0) })).rejects.toThrow("money is invalid");
    expect(() => etsyMoneyInChf(validateEtsyMoney({ amount: 1000, divisor: 1000, currency_code: "USD" }))).toThrow("conversion unavailable");
    vi.stubEnv("ETSY_FX_RATES_JSON", JSON.stringify({ USD: { chfPerUnit: 0.8, asOf: "2026-10-15T12:00:00Z" } }));
    expect(etsyMoneyInChf({ amount: 1000, divisor: 1000, currency_code: "USD" }, new Date("2026-10-15T18:00:00Z"))).toEqual({
      amountChf: 0.8, rate: 0.8, asOf: "2026-10-15T12:00:00Z",
    });
    expect(() => etsyMoneyInChf({ amount: 1, divisor: 100, currency_code: "USD" }, new Date("2026-10-17T18:00:00Z"))).toThrow("conversion unavailable");
  });

  it("keeps absent and malformed counters unknown rather than zero", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ results: [
      { listing_id: 456, num_favorers: 7 },
      { listing_id: 789, views: -1, num_favorers: null },
      { listing_id: 888, views: 0, num_favorers: 0 },
    ] })));
    expect(await client().getListingStats([{ etsyListingId: "456" }, { etsyListingId: "789" }, { etsyListingId: "888" }])).toEqual({
      "456": { views: null, favorites: 7 }, "789": { views: null, favorites: null }, "888": { views: 0, favorites: 0 },
    });
  });

  it("shares one token refresh between concurrent clients and persists using compare-and-swap", async () => {
    const expired = { ...tokens(), expiresAt: 0 };
    let stored = expired;
    const save = vi.fn(async (next: EtsyTokens, expected?: EtsyTokens) => {
      expect(expected?.refreshToken).toBe(expired.refreshToken);
      stored = next;
      return next;
    });
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("/oauth/token")) return json({ access_token: "123.next", refresh_token: "123.rotated", expires_in: 3600 });
      return json({ results: [] });
    });
    vi.stubGlobal("fetch", fetchImpl);
    const first = new EtsyLiveClient(expired, save, "123", async () => stored);
    const second = new EtsyLiveClient(expired, save, "123", async () => stored);
    await Promise.all([first.getListingStats([{ etsyListingId: "456" }]), second.getListingStats([{ etsyListingId: "456" }])]);
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).includes("/oauth/token"))).toHaveLength(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(stored.refreshToken).toBe("123.rotated");
  });
});
