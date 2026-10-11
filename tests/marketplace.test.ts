import { afterEach, describe, expect, it, vi } from "vitest";
import { EtsyDryRunAdapter } from "@/adapters/etsy/dryrun";
import type { EtsyAdapter } from "@/adapters/etsy/types";
import { EtsyMarketplace } from "@/adapters/marketplace/etsy";
import { ShopifyDryRunAdapter } from "@/adapters/marketplace/shopify-dryrun";
import type { MarketplaceListing } from "@/adapters/marketplace/types";

const listing: MarketplaceListing = {
  title: "Alpine poster",
  description: 'Mountain & lake\nPrinted <art> "A3"',
  tags: ["alpine", "poster"],
  priceChf: 29.9,
  productType: "pod",
  images: [
    { url: "https://example.com/mockup-front.png", alt: "Front mockup" },
    { url: "https://example.com/mockup-detail.png" },
  ],
};
const orderOptions = {
  since: new Date("2026-10-01T00:00:00Z"),
  candidates: [{ externalId: "123", priceChf: 29.9, productType: "pod" as const }],
  simulateAtLeastOne: true,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Etsy marketplace wrapper", () => {
  function adapter(mode: EtsyAdapter["mode"] = "live"): EtsyAdapter {
    return {
      mode,
      createDraftListing: vi.fn(async () => ({ listingId: "123" })),
      uploadListingImage: vi.fn(async () => {}),
      uploadListingFile: vi.fn(async () => {}),
      activateListing: vi.fn(async () => {}),
      getListingStats: vi.fn(async () => ({})),
      getReceipts: vi.fn(async () => [{
        receiptId: "456-789", etsyListingId: "123", buyerCountry: "CH",
        quantity: 2, totalChf: 59.8, createdAt: orderOptions.since,
      }]),
    };
  }

  it.each(["live", "dry-run"] as const)("preserves %s mode and delegates draft creation and uploads unchanged", async (mode) => {
    const etsy = adapter(mode);
    const marketplace = new EtsyMarketplace(etsy);
    const file = { name: "art.png", url: "https://example.com/delivery.png" };
    expect(marketplace.id).toBe("etsy");
    expect(marketplace.mode).toBe(mode);
    expect(await marketplace.upsertListing({ ...listing, productType: "digital", quantity: 3, files: [file] }))
      .toEqual({ externalId: "123", status: "draft" });
    expect(etsy.createDraftListing).toHaveBeenCalledExactlyOnceWith({
      title: listing.title, description: listing.description, priceChf: listing.priceChf,
      tags: listing.tags, type: "download", quantity: 3,
    });
    expect(etsy.uploadListingImage).toHaveBeenNthCalledWith(1, "123", listing.images[0].url);
    expect(etsy.uploadListingImage).toHaveBeenNthCalledWith(2, "123", listing.images[1].url);
    expect(etsy.uploadListingFile).toHaveBeenCalledExactlyOnceWith("123", file);
    expect(etsy.activateListing).not.toHaveBeenCalled();
    expect(await marketplace.getListingStatus("123")).toEqual({ externalId: "123", status: "unknown" });
    expect(etsy.getListingStats).not.toHaveBeenCalled();
  });

  it("maps physical drafts and receipt identifiers without changing amounts or simulation options", async () => {
    const etsy = adapter();
    const marketplace = new EtsyMarketplace(etsy);
    await marketplace.upsertListing(listing);
    expect(etsy.createDraftListing).toHaveBeenCalledExactlyOnceWith({
      title: listing.title, description: listing.description, priceChf: listing.priceChf,
      tags: listing.tags, type: "physical",
    });
    expect(await marketplace.listOrders(orderOptions)).toEqual([{
      orderId: "456-789", externalListingId: "123", buyerCountry: "CH",
      quantity: 2, totalChf: 59.8, createdAt: orderOptions.since,
    }]);
    expect(etsy.getReceipts).toHaveBeenCalledExactlyOnceWith({
      since: orderOptions.since,
      candidates: [{ etsyListingId: "123", priceChf: 29.9, productType: "pod" }],
      simulateAtLeastOne: true,
    });
  });

  it("rejects unsupported updates and variants before making any writes", async () => {
    const etsy = adapter();
    const marketplace = new EtsyMarketplace(etsy);
    await expect(marketplace.upsertListing({ ...listing, externalId: "123" })).rejects.toThrow("updates are not supported");
    await expect(marketplace.upsertListing({
      ...listing, variants: [{ optionValues: [{ optionName: "Size", name: "A3" }] }],
    })).rejects.toThrow("variants are not supported");
    expect(etsy.createDraftListing).not.toHaveBeenCalled();
  });

  it("works with the existing Etsy dry-run adapter without fetch", async () => {
    const fetch = vi.fn(() => { throw new Error("Unexpected network call"); });
    vi.stubGlobal("fetch", fetch);
    const etsy = new EtsyDryRunAdapter(() => 0.2);
    const marketplace = new EtsyMarketplace(etsy);
    const result = await marketplace.upsertListing(listing);
    expect(result.externalId).toMatch(/^dry-/);
    expect(etsy.calls.map((call) => call.op)).toEqual(["createDraftListing", "uploadListingImage", "uploadListingImage"]);
    const receipts = await marketplace.listOrders(orderOptions);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ externalListingId: "123", totalChf: 29.9, quantity: 1 });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("Shopify dry-run preview", () => {
  it("maps fixture copy, tags, prices, variants and URL images to productSet without mutating the listing", async () => {
    const input: MarketplaceListing = {
      ...listing,
      variants: [
        { optionValues: [{ optionName: "Size", name: "A3" }, { optionName: "Frame", name: "None" }] },
        { priceChf: 39.9, optionValues: [{ optionName: "Size", name: "A2" }, { optionName: "Frame", name: "None" }] },
      ],
    };
    const before = structuredClone(input);
    const marketplace = new ShopifyDryRunAdapter();
    const result = await marketplace.upsertListing(input);
    expect(marketplace.id).toBe("shopify");
    expect(marketplace.mode).toBe("dry-run");
    expect(result.externalId).toBeNull();
    expect(result.status).toBe("draft");
    expect(result.payloadPreview.query).toContain("productSet(input: $input, synchronous: $synchronous, identifier: $identifier)");
    expect(result.payloadPreview.variables).toEqual({
      synchronous: true,
      input: {
        title: listing.title,
        descriptionHtml: "Mountain &amp; lake<br>Printed &lt;art&gt; &quot;A3&quot;",
        tags: listing.tags,
        status: "DRAFT",
        productOptions: [
          { name: "Size", values: [{ name: "A3" }, { name: "A2" }] },
          { name: "Frame", values: [{ name: "None" }] },
        ],
        variants: [
          { price: "29.90", optionValues: input.variants![0].optionValues, inventoryItem: { requiresShipping: true } },
          { price: "39.90", optionValues: input.variants![1].optionValues, inventoryItem: { requiresShipping: true } },
        ],
        files: [
          { originalSource: listing.images[0].url, contentType: "IMAGE", alt: "Front mockup" },
          { originalSource: listing.images[1].url, contentType: "IMAGE" },
        ],
      },
    });
    expect(input).toEqual(before);
  });

  it("uses Shopify's single-variant convention and never exposes digital delivery files", async () => {
    const result = await new ShopifyDryRunAdapter().upsertListing({
      ...listing, productType: "digital", files: [{ name: "private.png", url: "https://example.com/private.png" }],
    });
    expect(result.payloadPreview.variables.input.productOptions).toEqual([
      { name: "Title", values: [{ name: "Default Title" }] },
    ]);
    expect(result.payloadPreview.variables.input.variants).toEqual([{
      price: "29.90", optionValues: [{ optionName: "Title", name: "Default Title" }],
      inventoryItem: { requiresShipping: false },
    }]);
    expect(JSON.stringify(result.payloadPreview)).not.toContain("private.png");
  });

  it("never calls fetch for previews, status reads or orders, even with an existing product ID", async () => {
    const fetch = vi.fn(() => { throw new Error("Unexpected network call"); });
    vi.stubGlobal("fetch", fetch);
    const marketplace = new ShopifyDryRunAdapter();
    const externalId = "gid://shopify/Product/123";
    const result = await marketplace.upsertListing({ ...listing, externalId });
    expect(result.externalId).toBe(externalId);
    expect(result.payloadPreview.variables.identifier).toEqual({ id: externalId });
    expect(await marketplace.getListingStatus(externalId)).toEqual({ externalId, status: "unknown" });
    expect(await marketplace.listOrders(orderOptions)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([NaN, Infinity, -1])("rejects invalid base and variant prices (%s)", async (priceChf) => {
    const marketplace = new ShopifyDryRunAdapter();
    await expect(marketplace.upsertListing({ ...listing, priceChf })).rejects.toThrow("CHF price");
    await expect(marketplace.upsertListing({
      ...listing, variants: [{ priceChf, optionValues: [{ optionName: "Size", name: "A3" }] }],
    })).rejects.toThrow("CHF price");
  });

  it.each(["data:image/png;base64,AA==", "blob:preview", "/api/mockup/poster", "https://viewer@example.com/a.png"])(
    "rejects blobs, relative URLs and URL credentials (%s)", async (url) => {
      await expect(new ShopifyDryRunAdapter().upsertListing({ ...listing, images: [{ url }] })).rejects.toThrow();
    },
  );

  it("rejects missing, inconsistent and duplicate variant options instead of inventing data", async () => {
    const marketplace = new ShopifyDryRunAdapter();
    for (const variants of [
      [],
      [{ optionValues: [] }],
      [{ optionValues: [{ optionName: "Size", name: "" }] }],
      [
        { optionValues: [{ optionName: "Size", name: "A3" }] },
        { optionValues: [{ optionName: "Frame", name: "None" }] },
      ],
      [
        { optionValues: [{ optionName: "Size", name: "A3" }] },
        { optionValues: [{ optionName: "Size", name: "A3" }] },
      ],
    ]) {
      await expect(marketplace.upsertListing({ ...listing, variants })).rejects.toThrow();
    }
  });
});
