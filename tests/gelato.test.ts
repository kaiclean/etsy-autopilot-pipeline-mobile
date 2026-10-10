import { afterEach, describe, expect, it, vi } from "vitest";
import { GelatoSupplier } from "@/adapters/supplier/gelato";
import { getSuppliers } from "@/adapters/supplier";
import type { SupplierProduct } from "@/adapters/supplier/types";

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

const product: SupplierProduct = {
  supplier: "gelato", preset: "tote", uid: "returned-catalog-uid", title: "Tote",
  baseCostUsd: null, currency: null, sourceUrl: "https://product.gelatoapis.com/v3/catalogs", fetchedAt: new Date(),
};

describe("Gelato official API client", () => {
  it("discovers real UIDs, uses X-API-KEY, caches and makes only catalog search POSTs", async () => {
    vi.stubEnv("GELATO_API_KEY", "fixture-gelato-key");
    vi.useFakeTimers();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json([{ catalogUid: "tote-catalog", title: "Tote Bags" }]))
      .mockResolvedValueOnce(Response.json({ products: [{ productUid: product.uid, attributes: { color: "Natural" } }], hits: {} }));
    const supplier = new GelatoSupplier(fetchImpl);
    const pending = supplier.listProducts("tote");
    await vi.runAllTimersAsync();
    const [found] = await pending;
    expect(found).toMatchObject({ uid: product.uid, title: "Tote Bags · Natural", baseCostUsd: null });
    expect(found.fetchedAt).toBeInstanceOf(Date);
    expect(found.sourceUrl).toBe("https://product.gelatoapis.com/v3/catalogs/tote-catalog/products:search");
    expect(fetchImpl.mock.calls[0]).toMatchObject([
      "https://product.gelatoapis.com/v3/catalogs",
      { headers: { "X-API-KEY": "fixture-gelato-key" }, method: "GET", redirect: "error" },
    ]);
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({ limit: 100, offset: 0 });
    expect(await supplier.listProducts("tote")).toEqual([found]);
    const input = { preset: "tote" as const, title: "Tote", description: "Tote", imageUrl: "https://cdn.example/art.png", tags: [], priceChf: 20 };
    const created = await supplier.createProduct(input);
    expect(await supplier.createProduct(input)).toEqual(created);
    expect(created.productId).toMatch(/^dry-gelato-/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reads the quantity-one USD country price without inventing shipping", async () => {
    vi.stubEnv("GELATO_API_KEY", "fixture-gelato-key");
    const fetchImpl = vi.fn().mockResolvedValueOnce(Response.json([
      { productUid: product.uid, country: "CH", quantity: 2, price: 8, currency: "USD" },
      { productUid: product.uid, country: "CH", quantity: 1, price: 10.25, currency: "USD" },
    ]));
    const supplier = new GelatoSupplier(fetchImpl);
    expect(await supplier.quote(product, "CH")).toMatchObject({ baseCostUsd: 10.25, shippingUsd: null, currency: "USD" });
    expect(fetchImpl.mock.calls[0][0]).toBe(`https://product.gelatoapis.com/v3/products/${product.uid}/prices?country=CH&currency=USD`);
    expect(fetchImpl.mock.calls[0][1].method).toBe("GET");
  });

  it.each([{ rows: [] }, { rows: [{ productUid: product.uid, country: "CH", quantity: 1, price: 10, currency: "EUR" }] }])("keeps missing or currency-mismatched prices unknown", async ({ rows }) => {
    vi.stubEnv("GELATO_API_KEY", "fixture-gelato-key");
    expect(await new GelatoSupplier(vi.fn().mockResolvedValue(Response.json(rows))).quote(product, "CH"))
      .toMatchObject({ baseCostUsd: null, shippingUsd: null });
  });

  it.each([401, 500, 429])("reports HTTP %s without upstream secret/body leakage", async (status) => {
    vi.stubEnv("GELATO_API_KEY", "fixture-gelato-key");
    const fetchImpl = vi.fn().mockResolvedValue(new Response("fixture-gelato-key artwork base64", { status }));
    await expect(new GelatoSupplier(fetchImpl).listProducts("tote")).rejects.toThrow(`Supplier API returned ${status}`);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects malformed schemas and invalid countries without guessing data", async () => {
    vi.stubEnv("GELATO_API_KEY", "fixture-gelato-key");
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ products: "bad" }));
    await expect(new GelatoSupplier(fetchImpl).listProducts("tote")).rejects.toThrow("Invalid Gelato catalog response");
    await expect(new GelatoSupplier(fetchImpl).quote(product, "Switzerland")).rejects.toThrow("Invalid Gelato quote input");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("reads v4 fulfillment statuses but never requests synthetic orders", async () => {
    vi.stubEnv("GELATO_API_KEY", "fixture-gelato-key");
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ fulfillmentStatus: "shipped" }));
    expect(await new GelatoSupplier(fetchImpl).getOrderStatuses(["dry-order", "real-order"]))
      .toEqual({ "dry-order": "pending", "real-order": "shipped" });
    expect(fetchImpl.mock.calls[0][0]).toBe("https://order.gelatoapis.com/v4/orders/real-order");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("returns only configured suppliers and creation stays simulated even on a live host", async () => {
    vi.stubEnv("PRINTIFY_API_TOKEN", "");
    vi.stubEnv("PRINTIFY_SHOP_ID", "");
    vi.stubEnv("GELATO_API_KEY", "");
    expect(getSuppliers()).toEqual([]);
    vi.stubEnv("PRINTIFY_API_TOKEN", "fixture-token");
    vi.stubEnv("PRINTIFY_SHOP_ID", "1");
    expect(getSuppliers().map((supplier) => supplier.id)).toEqual(["printify"]);
    vi.stubEnv("GELATO_API_KEY", "fixture-gelato-key");
    vi.stubEnv("PUBLISH_MODE", "live");
    expect(getSuppliers().map((supplier) => [supplier.id, supplier.mode])).toEqual([["printify", "dry-run"], ["gelato", "dry-run"]]);
  });
});
