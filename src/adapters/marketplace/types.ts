export type MarketplaceId = "etsy" | "shopify";

export type MarketplaceVariant = {
  priceChf?: number;
  optionValues: { optionName: string; name: string }[];
};

/** URL-only projection; never pass image blobs or private delivery files as gallery images. */
export type MarketplaceListing = {
  externalId?: string;
  title: string;
  description: string;
  tags: string[];
  priceChf: number;
  productType: "digital" | "pod";
  quantity?: number;
  images: { url: string; alt?: string }[];
  files?: { name: string; url: string }[];
  variants?: MarketplaceVariant[];
};

export type MarketplaceListingStatus = {
  externalId: string | null;
  status: "draft" | "active" | "archived" | "unknown";
};

export type MarketplaceListingResult<Payload = unknown> = MarketplaceListingStatus & {
  payloadPreview?: Payload;
};

export type MarketplaceOrderOptions = {
  since: Date;
  /** Candidates and simulation flag only drive the existing Etsy dry-run simulation. */
  candidates: { externalId: string; priceChf: number; productType: "digital" | "pod" }[];
  simulateAtLeastOne?: boolean;
};

export type MarketplaceOrder = {
  orderId: string;
  externalListingId: string;
  buyerCountry: string;
  quantity: number;
  totalChf: number;
  createdAt: Date;
};

export interface Marketplace<Payload = unknown> {
  readonly id: MarketplaceId;
  readonly mode: "dry-run" | "live";
  /** Prepares a draft. Unsupported updates must fail rather than create duplicates. */
  upsertListing(input: MarketplaceListing): Promise<MarketplaceListingResult<Payload>>;
  /** Unknown means no authoritative status read is available. */
  getListingStatus(externalId: string): Promise<MarketplaceListingStatus>;
  listOrders(options: MarketplaceOrderOptions): Promise<MarketplaceOrder[]>;
}
