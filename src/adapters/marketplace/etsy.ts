import type { EtsyAdapter } from "@/adapters/etsy/types";
import type { Marketplace, MarketplaceListing, MarketplaceOrderOptions } from "./types";

/** Wrap an adapter selected by getEtsyAdapter; never select mode or activate listings here. */
export class EtsyMarketplace implements Marketplace {
  readonly id = "etsy" as const;

  constructor(private readonly adapter: EtsyAdapter) {}

  get mode() {
    return this.adapter.mode;
  }

  async upsertListing(input: MarketplaceListing) {
    if (input.externalId !== undefined) throw new Error("Etsy listing updates are not supported by the existing adapter");
    if (input.variants?.length) throw new Error("Etsy variants are not supported by the existing adapter");
    const { listingId } = await this.adapter.createDraftListing({
      title: input.title,
      description: input.description,
      priceChf: input.priceChf,
      tags: input.tags,
      type: input.productType === "digital" ? "download" : "physical",
      ...(input.quantity !== undefined ? { quantity: input.quantity } : {}),
    });
    for (const image of input.images) await this.adapter.uploadListingImage(listingId, image.url);
    for (const file of input.files ?? []) await this.adapter.uploadListingFile(listingId, file);
    return { externalId: listingId, status: "draft" as const };
  }

  async getListingStatus(externalId: string) {
    return { externalId, status: "unknown" as const };
  }

  async listOrders(options: MarketplaceOrderOptions) {
    const receipts = await this.adapter.getReceipts({
      since: options.since,
      candidates: options.candidates.map(({ externalId, ...candidate }) => ({ etsyListingId: externalId, ...candidate })),
      ...(options.simulateAtLeastOne !== undefined ? { simulateAtLeastOne: options.simulateAtLeastOne } : {}),
    });
    return receipts.map(({ receiptId, etsyListingId, ...receipt }) => ({
      orderId: receiptId,
      externalListingId: etsyListingId,
      ...receipt,
    }));
  }
}
