import { afterEach, describe, expect, it, vi } from "vitest";
import { PrintifySupplier } from "@/adapters/supplier/printify";
import { GelatoDryRunSupplier } from "@/adapters/supplier/gelato-dryrun";
import { SupplierHttp } from "@/adapters/supplier/http";
import type { Supplier, SupplierProduct, SupplierProductInput } from "@/adapters/supplier/types";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const input: SupplierProductInput = {
  preset: "tote", title: "Mountain Tote Bag", description: "Made to order", tags: ["mountain art"],
  priceChf: 29.9, imageUrl: "https://cdn.example/design.png", publishToEtsy: true,
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
    expect(await supplier.quote(product, "CH")).toMatchObject({ baseCostUsd: null, shippingUsd: null });
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
      headers: { "X-API-KEY": "test-secret" }, redirect: "error", method: "GET",
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
      expect(await quote).toMatchObject({ baseCostUsd: null, shippingUsd: 4.99 });
      await supplier.listProducts("tote");
      expect(fetchImpl).toHaveBeenCalledTimes(5);
    });

    it("reads available variant cost, not retail price, without creating a shop product", async () => {
      vi.stubEnv("PRINTIFY_API_TOKEN", "fixture-token");
      vi.stubEnv("PRINTIFY_SHOP_ID", "1");
      vi.useFakeTimers();
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(Response.json({ data: [{ id: "existing-product", blueprint_id: 101, print_provider_id: 201 }], last_page: 1 }))
        .mockResolvedValueOnce(Response.json({ variants: [{ id: 301, cost: 1250, price: 2990, is_available: true }] }));
      const supplier = new PrintifySupplier(fetchImpl);
      const quote = supplier.quote({
        supplier: "printify", preset: "tote", uid: "101:201:301", title: "Tote", baseCostUsd: null,
        currency: null, blueprintId: 101, printProviderId: 201, variantId: 301,
        sourceUrl: "https://api.printify.com/v1/catalog", fetchedAt: new Date(),
      }, "CH");
      await vi.runAllTimersAsync();
      expect(await quote).toMatchObject({ baseCostUsd: 12.5, shippingUsd: null });
      expect((await quote).sourceUrl).toContain("existing-product.json");
      expect(fetchImpl.mock.calls.every((call) => call[1].method === "GET")).toBe(true);
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

  it("does not expose malformed response content in JSON errors", async () => {
    const http = new SupplierHttp("https://product.gelatoapis.com/v3", {},
      vi.fn().mockResolvedValue(new Response("echoed-sensitive-content")));
    await expect(http.request("/catalogs")).rejects.toThrow("Invalid supplier API JSON response");
  });
});
