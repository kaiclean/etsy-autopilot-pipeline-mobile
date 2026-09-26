export type EtsyDraftInput = {
  title: string;
  description: string;
  priceChf: number;
  tags: string[];
  type: "download" | "physical";
  quantity?: number;
};

export type EtsyReceipt = {
  receiptId: string;
  etsyListingId: string;
  buyerCountry: string;
  quantity: number;
  totalChf: number;
  createdAt: Date;
};

export type ReceiptCandidate = { etsyListingId: string; priceChf: number; productType: "digital" | "pod" };

export interface EtsyAdapter {
  readonly mode: "dry-run" | "live";
  createDraftListing(input: EtsyDraftInput): Promise<{ listingId: string }>;
  uploadListingImage(listingId: string, imageUrl: string): Promise<void>;
  uploadListingFile(listingId: string, file: { name: string; url: string }): Promise<void>;
  /** `candidates` and `simulateAtLeastOne` only drive the dry-run simulation. */
  getReceipts(opts: { since: Date; candidates: ReceiptCandidate[]; simulateAtLeastOne?: boolean }): Promise<EtsyReceipt[]>;
  /** Cumulative lifetime stats per Etsy listing id. `current` lets the dry-run adapter grow from known totals. */
  getListingStats(
    current: { etsyListingId: string; views: number; favorites: number }[],
  ): Promise<Record<string, { views: number; favorites: number }>>;
}
