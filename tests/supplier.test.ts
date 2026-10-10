import { afterEach, describe, expect, it, vi } from "vitest";
import { PrintifySupplier } from "@/adapters/supplier/printify";
import { GelatoDryRunSupplier } from "@/adapters/supplier/gelato-dryrun";
import { GelatoSupplier } from "@/adapters/supplier/gelato";
import { SupplierHttp } from "@/adapters/supplier/http";
import type { Supplier, SupplierProduct, SupplierProductInput } from "@/adapters/supplier/types";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const input: SupplierProductInput = {
  preset: "tote", title: "Mountain Tote Bag", description: "Made to order", tags: ["mountain art"],
  priceChf: 29.9, imageUrl: "https://cdn.example/design.png", publishToEtsy: true,
};
const printifyProduct: SupplierProduct = {
  supplier: "printify", preset: "tote", uid: "101:201:301", title: "Tote", baseCostUsd: null,
  currency: null, blueprintId: 101, printProviderId: 201, variantId: 301,
  sourceUrl: "https://api.printify.com/v1/catalog", fetchedAt: new Date(),
};
const gelatoProduct: SupplierProduct = {
  supplier: "gelato", preset: "tote", uid: "catalog-tote", title: "Tote", baseCostUsd: null,
  currency: null, sourceUrl: "https://product.gelatoapis.com/v3/catalogs", fetchedAt: new Date(),
};

describe("supplier dry-run contract", () => {
  it.each([new PrintifySupplier(), new GelatoDryRunSupplier()] as Supplier[])("%s never writes and returns deterministic ids and unknown quotes", async (supplier) => {
    vi.stubEnv("PRINTIFY_API_TOKEN", "");
    vi.stubEnv("PRINTIFY_SHOP_ID", "");
    const fetchSpy = vi.fn(() => { throw new Error("Network prohibited"); });
    vi.stubGlobal("fetch", fetchSpy);
    expect(supplier.mode).toBe("dry-run");
    expect(await supplier.listProducts()).toEqual([]);
    const first = await supplier.createProduct(input);
    expect(first.productId).toMatch(/^dry-/);
    expect(await supplier.createProduct(input)).toMatchObject(first);
    const product: SupplierProduct = {
      supplier: supplier.id, preset: "tote", uid: "fixture-only", title: "Tote Bag",
      baseCostUsd: null, currency: null, sourceUrl: "https://example.com/catalog", fetchedAt: new Date(),
    };
    expect(await supplier.quote(product, "CH")).toMatchObject({ baseCostUsd: null, shippingUsd: null, inStock: null, productionDays: null });
    expect(await supplier.getOrderStatuses(["dry-order-1"])).toEqual({ "dry-order-1": "pending" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("supplier HTTP safety", () => {
  it("uses authentication, refuses redirects and does not echo upstream secrets", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("echoed test-secret", { status: 401 }));
    const http = new SupplierHttp("https://product.gelatoapis.com/v3", { "X-API-KEY": "test-secret" }, fetchImpl);
    await expect(http.request("/catalogs")).rejects.toThrow("Supplier API returned 401");
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({
      headers: { "X-API-KEY": "test-secret" }, redirect: "error", method: "GET", cache: "no-store",
    });

  });

  describe("Printify catalog reads", () => {
    it("matches an official-shaped fixture, retains source metadata and never invents base cost", async () => {
      vi.stubEnv("PRINTIFY_API_TOKEN", "fixture-token");
      vi.stubEnv("PRINTIFY_SHOP_ID", "1");
      vi.useFakeTimers();
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(Response.json([{ id: 101, title: "Cotton Tote Bag" }]))
        .mockResolvedValueOnce(Response.json([{ id: 201, title: "Printify Choice" }]))
        .mockResolvedValueOnce(Response.json({ variants: [{ id: 301, title: '15" x 16" White' }] }))
        .mockResolvedValueOnce(Response.json({ profiles: [{ variant_ids: [301], countries: ["CH"], first_item: { cost: 499, currency: "USD" } }] }))
        .mockResolvedValueOnce(Response.json({ variants: [{ id: 301, title: '15" x 16" White' }] }))
        .mockResolvedValueOnce(Response.json({ profiles: [{ variant_ids: [301], countries: ["CH"], first_item: { cost: 499, currency: "USD" } }] }))
        .mockResolvedValueOnce(Response.json({ data: [], last_page: 1 }));
      const supplier = new PrintifySupplier(fetchImpl);
      const pending = supplier.listProducts("tote");
      await vi.runAllTimersAsync();
      const [product] = await pending;
      expect(product).toMatchObject({ uid: "101:201:301", preset: "tote", baseCostUsd: null });
      expect(product.sourceUrl).toMatch(/shipping\.json$/);
      expect(product.fetchedAt).toBeInstanceOf(Date);
      expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe(["Bearer", "fixture-token"].join(" "));
      const quote = supplier.quote(product, "CH");
      await vi.runAllTimersAsync();
      expect(await quote).toMatchObject({ baseCostUsd: null, shippingUsd: 4.99, inStock: null, productionDays: null });
      await supplier.listProducts("tote");
      expect(fetchImpl).toHaveBeenCalledTimes(7);
    });

    it("reads available variant cost, not retail price, without creating a shop product", async () => {
      vi.stubEnv("PRINTIFY_API_TOKEN", "fixture-token");
      vi.stubEnv("PRINTIFY_SHOP_ID", "1");
      vi.useFakeTimers();
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(Response.json({ variants: [{ id: 301, title: "One size", is_available: true }] }))
        .mockResolvedValueOnce(Response.json({ profiles: [] }))
        .mockResolvedValueOnce(Response.json({ data: [{ id: "existing-product", blueprint_id: 101, print_provider_id: 201 }], last_page: 1 }))
        .mockResolvedValueOnce(Response.json({ variants: [{ id: 301, cost: 1250, price: 2990, is_available: true }] }));
      const supplier = new PrintifySupplier(fetchImpl);
      const quote = supplier.quote(printifyProduct, "CH");
      await vi.runAllTimersAsync();
      expect(await quote).toMatchObject({ baseCostUsd: 12.5, shippingUsd: null, inStock: true });
      expect((await quote).sourceUrl).toContain("existing-product.json");
      expect(fetchImpl.mock.calls.every((call) => call[1].method === "GET")).toBe(true);
    });

    it("lists every provider with a preset variant instead of preselecting Printify Choice", async () => {
      vi.stubEnv("PRINTIFY_API_TOKEN", "fixture-token");
      vi.stubEnv("PRINTIFY_SHOP_ID", "1");
      vi.useFakeTimers();
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(Response.json([{ id: 101, title: "Cotton Tote Bag" }]))
        .mockResolvedValueOnce(Response.json([{ id: 201, title: "Printify Choice" }, { id: 202, title: "Other Provider" }]))
        .mockResolvedValueOnce(Response.json({ variants: [{ id: 301, title: "One size", is_available: false }] }))
        .mockResolvedValueOnce(Response.json({ profiles: [] }))
        .mockResolvedValueOnce(Response.json({ variants: [{ id: 302, title: "One size", is_available: true }] }))
        .mockResolvedValueOnce(Response.json({ profiles: [] }));
      const pending = new PrintifySupplier(fetchImpl).listProducts("tote");
      await vi.runAllTimersAsync();
      expect((await pending).map((row) => row.uid)).toEqual(["101:201:301", "101:202:302"]);
      expect(fetchImpl.mock.calls.map((row) => row[0]).filter((url) => url.endsWith("shipping.json"))).toHaveLength(2);
    });

    it.each([true, false, undefined])("preserves official variant stock %s without deriving it from cost", async (isAvailable) => {
      vi.stubEnv("PRINTIFY_API_TOKEN", "fixture-token");
      vi.stubEnv("PRINTIFY_SHOP_ID", "1");
      vi.useFakeTimers();
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(Response.json({ variants: [{ id: 301, title: "One size", cost: 1250, is_available: isAvailable }] }))
        .mockResolvedValueOnce(Response.json({ profiles: [] }))
        .mockResolvedValueOnce(Response.json({ data: [], last_page: 1 }));
      const pending = new PrintifySupplier(fetchImpl).quote(printifyProduct, "CH");
      await vi.runAllTimersAsync();
      expect(await pending).toMatchObject({ baseCostUsd: 12.5, shippingUsd: null, inStock: isAvailable ?? null, productionDays: null, currency: "USD" });
      expect(fetchImpl).toHaveBeenCalledTimes(isAvailable == null ? 3 : 2);
    });

    it.each([
      { variant: { price: 2990 }, shipping: { cost: 400, currency: "EUR" } },
      { variant: { cost: -1 }, shipping: { cost: -1, currency: "USD" } },
      { variant: { cost: 1250, currency: "EUR" }, shipping: { cost: 400 } },
    ])("keeps invalid, retail-only or unsupported-currency costs unknown", async ({ variant, shipping }) => {
      vi.stubEnv("PRINTIFY_API_TOKEN", "fixture-token");
      vi.stubEnv("PRINTIFY_SHOP_ID", "1");
      vi.useFakeTimers();
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(Response.json({ variants: [{ id: 301, title: "One size", ...variant }] }))
        .mockResolvedValueOnce(Response.json({ profiles: [{ variant_ids: [301], countries: ["CH"], first_item: shipping }] }))
        .mockResolvedValueOnce(Response.json({ data: [], last_page: 1 }));
      const pending = new PrintifySupplier(fetchImpl).quote(printifyProduct, "CH");
      await vi.runAllTimersAsync();
      expect(await pending).toMatchObject({ baseCostUsd: null, shippingUsd: null, inStock: null });
    });

    it("refreshes stock, base cost and shipping on every quote instead of using listing-time caches", async () => {
      vi.stubEnv("PRINTIFY_API_TOKEN", "fixture-token");
      vi.stubEnv("PRINTIFY_SHOP_ID", "1");
      vi.useFakeTimers();
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(Response.json({ variants: [{ id: 301, title: "One size", cost: 1250, is_available: true }] }))
        .mockResolvedValueOnce(Response.json({ profiles: [{ variant_ids: [301], countries: ["REST_OF_THE_WORLD"], first_item: { cost: 400, currency: "USD" } }] }))
        .mockResolvedValueOnce(Response.json({ variants: [{ id: 301, title: "One size", cost: 1400, is_available: false }] }))
        .mockResolvedValueOnce(Response.json({ profiles: [
          { variant_ids: [301], countries: ["REST_OF_THE_WORLD"], first_item: { cost: 400, currency: "USD" } },
          { variant_ids: [301], countries: ["CH"], first_item: { cost: 550, currency: "USD" } },
        ] }));
      const supplier = new PrintifySupplier(fetchImpl);
      const first = supplier.quote(printifyProduct, "CH");
      await vi.runAllTimersAsync();
      expect(await first).toMatchObject({ baseCostUsd: 12.5, shippingUsd: 4, inStock: true });
      const second = supplier.quote(printifyProduct, "CH");
      await vi.runAllTimersAsync();
      expect(await second).toMatchObject({ baseCostUsd: 14, shippingUsd: 5.5, inStock: false });
      expect((await second).fetchedAt.getTime()).toBeGreaterThan((await first).fetchedAt.getTime());
      expect((await second).sourceUrl).toContain("/print_providers/201/variants.json");
      expect(fetchImpl.mock.calls.every((call) => call[1].cache === "no-store" && call[1].method === "GET")).toBe(true);
    });

    it.each([
      { handling: { value: 3, unit: "day" }, expected: 3 },
      { handling: { value: 4, unit: "days" }, expected: 4 },
      { handling: { value: 72, unit: "hour" }, expected: null },
      { handling: { value: -1, unit: "day" }, expected: null },
      { handling: { value: 2.5, unit: "day" }, expected: null },
      { handling: { value: 3 }, expected: null },
    ])("reads production days only from valid day-based handling time", async ({ handling, expected }) => {
      vi.stubEnv("PRINTIFY_API_TOKEN", "fixture-token");
      vi.stubEnv("PRINTIFY_SHOP_ID", "1");
      vi.useFakeTimers();
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(Response.json({ variants: [{ id: 301, title: "One size", cost: 1250, is_available: true }] }))
        .mockResolvedValueOnce(Response.json({ handling_time: handling, profiles: [] }));
      const pending = new PrintifySupplier(fetchImpl).quote(printifyProduct, "CH");
      await vi.runAllTimersAsync();
      expect((await pending).productionDays).toBe(expected);
      expect(fetchImpl.mock.calls[0][0]).toContain("variants.json?show-out-of-stock=1");
    });

    it.each([true, false, undefined])("reads existing product stock %s when catalog availability is unknown", async (isAvailable) => {
      vi.stubEnv("PRINTIFY_API_TOKEN", "fixture-token");
      vi.stubEnv("PRINTIFY_SHOP_ID", "1");
      vi.useFakeTimers();
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(Response.json({ variants: [{ id: 301, title: "One size", cost: 1250 }] }))
        .mockResolvedValueOnce(Response.json({ profiles: [] }))
        .mockResolvedValueOnce(Response.json({ data: [{ id: "existing-product", blueprint_id: 101, print_provider_id: 201 }], last_page: 1 }))
        .mockResolvedValueOnce(Response.json({ variants: [{ id: 301, price: 2990, is_available: isAvailable }] }));
      const pending = new PrintifySupplier(fetchImpl).quote(printifyProduct, "CH");
      await vi.runAllTimersAsync();
      expect(await pending).toMatchObject({ baseCostUsd: 12.5, shippingUsd: null, inStock: isAvailable ?? null });
    });

    it("keeps valid provider candidates when another variants or shipping read fails", async () => {
      vi.stubEnv("PRINTIFY_API_TOKEN", "fixture-token");
      vi.stubEnv("PRINTIFY_SHOP_ID", "1");
      vi.useFakeTimers();
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(Response.json([{ id: 101, title: "Cotton Tote Bag" }]))
        .mockResolvedValueOnce(Response.json([{ id: 200, title: "Unavailable" }, { id: 201, title: "No shipping" }, { id: 202, title: "Available" }]))
        .mockResolvedValueOnce(new Response("", { status: 503 }))
        .mockResolvedValueOnce(Response.json({ variants: [{ id: 301, title: "One size" }] }))
        .mockResolvedValueOnce(new Response("", { status: 503 }))
        .mockResolvedValueOnce(Response.json({ variants: [{ id: 302, title: "One size" }] }))
        .mockResolvedValueOnce(Response.json({ profiles: [] }));
      const pending = new PrintifySupplier(fetchImpl).listProducts("tote");
      await vi.runAllTimersAsync();
      expect((await pending).map((row) => row.uid)).toEqual(["101:201:301", "101:202:302"]);
    });

    it("retains cost and stock with unknown shipping when one quote read fails", async () => {
      vi.stubEnv("PRINTIFY_API_TOKEN", "fixture-token");
      vi.stubEnv("PRINTIFY_SHOP_ID", "1");
      vi.useFakeTimers();
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(Response.json({ variants: [{ id: 301, title: "One size", cost: 1250, is_available: true }] }))
        .mockResolvedValueOnce(new Response("", { status: 503 }));
      const pending = new PrintifySupplier(fetchImpl).quote(printifyProduct, "CH");
      await vi.runAllTimersAsync();
      expect(await pending).toMatchObject({ baseCostUsd: 12.5, inStock: true, shippingUsd: null, productionDays: null });
    });
  });

  it("honors rate-limit cooldown without retrying requests", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429, headers: { "Retry-After": "5" } }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    const http = new SupplierHttp("https://product.gelatoapis.com/v3", {}, fetchImpl);
    await expect(http.request("/catalogs")).rejects.toThrow("rate limited");
    const next = http.request("/catalogs");
    await vi.advanceTimersByTimeAsync(4999);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(next).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("backs off consecutive rate limits without replaying a write", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    const http = new SupplierHttp("https://product.gelatoapis.com/v3", {}, fetchImpl);
    await expect(http.request("/catalogs/products:search", { limit: 1 })).rejects.toThrow("rate limited");
    const second = expect(http.request("/catalogs")).rejects.toThrow("rate limited");
    await vi.advanceTimersByTimeAsync(60_000);
    await second;
    const third = http.request("/catalogs");
    await vi.advanceTimersByTimeAsync(119_999);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(third).resolves.toEqual({ ok: true });
    expect(fetchImpl.mock.calls.filter((call) => call[1].method === "POST")).toHaveLength(1);
  });

  it("does not expose malformed response content in JSON errors", async () => {
    const http = new SupplierHttp("https://product.gelatoapis.com/v3", {},
      vi.fn().mockResolvedValue(new Response("echoed-sensitive-content")));
    await expect(http.request("/catalogs")).rejects.toThrow("Invalid supplier API JSON response");
  });

  describe("Gelato quote evidence", () => {
    it.each([undefined, false])("does not infer stock or shipping from a price or unverified availability field %s", async (isAvailable) => {
      vi.stubEnv("GELATO_API_KEY", "fixture-gelato-key");
      const fetchImpl = vi.fn().mockResolvedValueOnce(Response.json([{
        productUid: gelatoProduct.uid, country: "CH", quantity: 1, price: 10.25, currency: "USD", is_available: isAvailable,
      }])).mockResolvedValueOnce(Response.json({ shipmentMethods: [{ shipmentMethodUid: "standard", supportedCountries: ["CH"], price: 3 }] }));
      const quote = await new GelatoSupplier(fetchImpl).quote(gelatoProduct, "CH");
      expect(quote).toMatchObject({ baseCostUsd: 10.25, shippingUsd: null, inStock: null, productionDays: null, currency: "USD" });
      expect(quote.sourceUrl).toContain(`/products/${gelatoProduct.uid}/prices?country=CH&currency=USD`);
      expect(quote.fetchedAt).toBeInstanceOf(Date);
      expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: "GET", cache: "no-store" });
      expect(fetchImpl.mock.calls[1]).toMatchObject([
        "https://shipment.gelatoapis.com/v1/shipment-methods?country=CH",
        { method: "GET", headers: { "X-API-KEY": "fixture-gelato-key" }, cache: "no-store" },
      ]);
    });

    it.each([
      { rows: [] },
      { rows: [{ productUid: gelatoProduct.uid, country: "CH", quantity: 1, price: 10, currency: "EUR" }] },
      { rows: [{ productUid: gelatoProduct.uid, country: "CH", quantity: 1, price: -1, currency: "USD" }] },
    ])("keeps missing or unusable prices and shipping unknown", async ({ rows }) => {
      vi.stubEnv("GELATO_API_KEY", "fixture-gelato-key");
      const quote = await new GelatoSupplier(vi.fn().mockResolvedValueOnce(Response.json(rows))).quote(gelatoProduct, "CH");
      expect(quote).toMatchObject({ baseCostUsd: null, shippingUsd: null, inStock: null, productionDays: null });
    });

    it("reads fresh quantity-one country pricing for each quote", async () => {
      vi.stubEnv("GELATO_API_KEY", "fixture-gelato-key");
      vi.useFakeTimers();
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(Response.json([{ productUid: gelatoProduct.uid, country: "CH", quantity: 1, price: 10, currency: "USD" }]))
        .mockResolvedValueOnce(Response.json({ shipmentMethods: [] }))
        .mockResolvedValueOnce(Response.json({ productsAvailability: [] }))
        .mockResolvedValueOnce(Response.json([{ productUid: gelatoProduct.uid, country: "CH", quantity: 1, price: 12, currency: "USD" }]))
        .mockResolvedValueOnce(Response.json({ shipmentMethods: [] }))
        .mockResolvedValueOnce(Response.json({ productsAvailability: [] }));
      const supplier = new GelatoSupplier(fetchImpl);
      const first = supplier.quote(gelatoProduct, "CH");
      await vi.runAllTimersAsync();
      expect((await first).baseCostUsd).toBe(10);
      const second = supplier.quote(gelatoProduct, "CH");
      await vi.runAllTimersAsync();
      expect((await second).baseCostUsd).toBe(12);
      expect(fetchImpl).toHaveBeenCalledTimes(6);
    });

    it.each([
      { country: "CH", stockRegion: "EU", status: "in-stock", expected: true },
      { country: "DE", stockRegion: "EU", status: "out-of-stock", expected: false },
      { country: "US", stockRegion: "US-CA", status: "in-stock", expected: true },
      { country: "CA", stockRegion: "US-CA", status: "out-of-stock-replenishable", expected: false },
      { country: "GB", stockRegion: "UK", status: "out-of-stock", expected: false },
      { country: "CH", stockRegion: "EU", status: "non-stockable", expected: null },
      { country: "CH", stockRegion: "EU", status: "not-supported", expected: null },
      { country: "CH", stockRegion: "EU", status: "unknown", expected: null },
      { country: "CH", stockRegion: "US-CA", status: "in-stock", expected: null },
      { country: "JP", stockRegion: "EU", status: "in-stock", expected: null },
    ])("uses only explicit $stockRegion regional stock $status for $country", async ({ country, stockRegion, status, expected }) => {
      vi.stubEnv("GELATO_API_KEY", "fixture-gelato-key");
      vi.useFakeTimers();
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(Response.json([{ productUid: gelatoProduct.uid, country, quantity: 1, price: 10, currency: "USD" }]))
        .mockResolvedValueOnce(Response.json({ shipmentMethods: [] }))
        .mockResolvedValueOnce(Response.json({ productsAvailability: [{ productUid: gelatoProduct.uid, availability: [{ stockRegionUid: stockRegion, status }] }] }));
      const pending = new GelatoSupplier(fetchImpl).quote(gelatoProduct, country);
      await vi.runAllTimersAsync();
      expect(await pending).toMatchObject({ baseCostUsd: 10, shippingUsd: null, inStock: expected, productionDays: null });
      expect(fetchImpl.mock.calls[2]).toMatchObject([
        "https://product.gelatoapis.com/v3/stock/region-availability",
        { method: "POST", body: JSON.stringify({ products: [gelatoProduct.uid] }), cache: "no-store" },
      ]);
    });

    it.each([
      { productsAvailability: [] },
      { productsAvailability: [{ productUid: "different-product", availability: [{ stockRegionUid: "EU", status: "in-stock" }] }] },
      { productsAvailability: [{ productUid: gelatoProduct.uid, availability: [] }] },
      { productsAvailability: "malformed" },
    ])("does not invent stock for missing or malformed product evidence", async (stock) => {
      vi.stubEnv("GELATO_API_KEY", "fixture-gelato-key");
      vi.useFakeTimers();
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(Response.json([{ productUid: gelatoProduct.uid, country: "CH", quantity: 1, price: 10, currency: "USD" }]))
        .mockResolvedValueOnce(Response.json({ shipmentMethods: [] }))
        .mockResolvedValueOnce(Response.json(stock));
      const pending = new GelatoSupplier(fetchImpl).quote(gelatoProduct, "CH");
      await vi.runAllTimersAsync();
      expect(await pending).toMatchObject({ baseCostUsd: 10, shippingUsd: null, inStock: null, productionDays: null });
    });
  });
});
