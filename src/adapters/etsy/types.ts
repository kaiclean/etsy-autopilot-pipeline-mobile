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
  /** Numeric Etsy receipt id when it differs from `receiptId`. Ledger matching uses this. */
  etsyReceiptId?: string;
  etsyListingId: string;
  buyerCountry: string;
  quantity: number;
  /** Merchandise total (unit price × quantity), before shipping and discounts. */
  totalChf: number;
  shippingChf?: number;
  discountChf?: number;
  taxChf?: number;
  refundChf?: number;
  cancelled?: boolean;
  createdAt: Date;
};

export type EtsyLedgerEntry = Record<string, unknown>;

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
  /** Payment-account ledger. Covered by transactions_r. Read-only. */
  getLedgerEntries(opts: { since: Date; until: Date }): Promise<EtsyLedgerEntry[]>;
  /** Cumulative lifetime stats per Etsy listing id. `current` lets the dry-run adapter grow from known totals. */
  getListingStats(
    current: { etsyListingId: string; views: number; favorites: number }[],
  ): Promise<Record<string, { views: number; favorites: number }>>;
}
