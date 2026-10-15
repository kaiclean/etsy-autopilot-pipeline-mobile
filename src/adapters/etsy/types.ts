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
  modifiedAt?: Date;
  paid?: boolean;
  canceled?: boolean;
  /** Original unit price and the explicit conversion used; never a guessed divisor/currency. */
  originalMoney?: { amount: number; divisor: number; currency_code: string };
  fxRate?: number;
  fxAsOf?: string | null;
  refunded?: boolean;
};

export type EtsyListingStats = { views: number | null; favorites: number | null };
export type EtsyListingSnapshot = { listingId: string; shopId?: string; state: string; quantity?: number; title?: string; updatedAt?: Date };
export type ReceiptCandidate = { etsyListingId: string; priceChf: number; productType: "digital" | "pod" };

export interface EtsyAdapter {
  readonly mode: "dry-run" | "live";
  createDraftListing(input: EtsyDraftInput): Promise<{ listingId: string }>;
  uploadListingImage(listingId: string, imageUrl: string): Promise<void>;
  uploadListingFile(listingId: string, file: { name: string; url: string }): Promise<void>;
  /** Moves a draft to state=active. Dry-run records the call and does not touch Etsy. */
  activateListing(listingId: string): Promise<void>;
  /** `candidates` and `simulateAtLeastOne` only drive the dry-run simulation. */
  getReceipts(opts: { since: Date; candidates: ReceiptCandidate[]; simulateAtLeastOne?: boolean }): Promise<EtsyReceipt[]>;
  getReceipt?(receiptId: string): Promise<EtsyReceipt[]>;
  getListing?(listingId: string): Promise<EtsyListingSnapshot>;
  /** Cumulative lifetime stats per Etsy listing id. `current` lets the dry-run adapter grow from known totals. */
  getListingStats(
    current: { etsyListingId: string; views: number; favorites: number }[],
  ): Promise<Record<string, EtsyListingStats>>;
}
