import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { validateListing } from "@/lib/listing-validator";
import { runListing } from "@/pipeline/listing";

const adapter = vi.hoisted(() => ({ mode: "live", getProviderDetails: vi.fn() }));
vi.mock("@/adapters/printify", () => ({ getPrintifyAdapter: async () => adapter }));
vi.mock("@/adapters/llm", () => ({
  getLLMProvider: () => ({
    name: "fixture",
    writeListing: async () => ({
      title: "Swiss Alps Mug with Calm Alpine Lake Scene", tags: Array.from({ length: 13 }, (_, index) => `mountain scene ${index}`),
      body: "A mountain landscape.", costChf: 0, provider: "fixture",
    }),
  }),
}));
vi.mock("@/pipeline/sourcing", () => ({
  sourcedListingCosts: async () => ({ costs: { mug: 8 }, products: {}, suppliers: {}, estimates: {} }),
}));
vi.mock("@/lib/pricing-ladder", () => ({
  quoteLadder: () => [{
    id: "mug", label: "Mug", deliverable: "One mug", product: { type: "pod", pod: "mug" },
    priceChf: 20, podCostChf: 8, netChf: 5, marginPct: 25,
  }],
}));
vi.mock("@/pipeline/mockup", () => ({
  listingImageForProduct: async () => ({
    url: "/api/mockup/mug?fixture=1",
    gallery: [{ url: "/api/mockup/mug?fixture=1", role: "product-mockup", source: "illustrative" }],
  }),
}));

describe("listing-stage compliance holds", () => {
  it.each([
    { available: true, colorVariance: 20, expectedStatus: "pending_approval" },
    { available: false, colorVariance: 20, expectedStatus: "pending_approval" },
    { available: true, colorVariance: 0, expectedStatus: "quality_failed" },
  ])("keeps recoverable supplier holds queueable but blocks actual art failures ($available/$colorVariance)", async ({ available, colorVariance, expectedStatus }) => {
    const client = new PGlite("memory://");
    try {
      const db = drizzle(client, { schema }) as DB;
      await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
      const [shop] = await db.select().from(schema.shops).limit(1);
      await db.insert(schema.designs).values({
        shopId: shop.id, niche: "alpine", prompt: "Mountain scene", provider: "fixture",
        imageUrl: "https://cdn.example/artwork.png", imageWidth: 5000, imageHeight: 7000,
        colorVariance, qualityScore: 8, qualityReasons: [], isDemo: false,
      });
      const providerDetails = { processingMin: 2, processingMax: 4, shippingMin: 5, shippingMax: 9 };
      if (available) adapter.getProviderDetails.mockResolvedValue(providerDetails);
      else adapter.getProviderDetails.mockRejectedValue(new Error("Catalog timings unavailable"));
      const summary = await runListing({
        db, now: new Date(), shopId: shop.id, demo: false, log: () => {},
        trigger: "manual", random: () => 0,
      });
      const [listing] = await db.select().from(schema.listings);
      expect(listing.status).toBe(expectedStatus);
      expect(listing.validation.some((issue) => issue.code === "supplier_mockups_pending")).toBe(true);
      expect(listing.validation.some((issue) => issue.code === "missing_provider_timings")).toBe(!available);
      if (available) {
        expect(listing.copyProvenance).toMatchObject({ providerDetails });
        expect(listing.description).toContain("Shipping: 5–9 business days.");
      } else {
        expect(listing.description).not.toMatch(/\d+.*days/);
        expect(validateListing(listing).valid).toBe(false);
      }
      if (expectedStatus === "pending_approval") expect(String(summary)).toContain("Drafted 1 listings for approval");
    } finally {
      await client.close();
    }
  });
});
