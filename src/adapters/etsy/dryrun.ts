import type { EtsyAdapter, EtsyDraftInput, EtsyReceipt, ReceiptCandidate } from "./types";

const COUNTRIES = ["US", "US", "US", "DE", "GB", "CH", "CA", "AU", "FR", "NL", "AT"];

/** Records what would be sent to Etsy and fabricates plausible responses. Never makes network calls. */
export class EtsyDryRunAdapter implements EtsyAdapter {
  readonly mode = "dry-run" as const;
  readonly calls: { op: string; payload: unknown }[] = [];

  constructor(private random: () => number = Math.random) {}

  async createDraftListing(input: EtsyDraftInput) {
    this.calls.push({ op: "createDraftListing", payload: input });
    return { listingId: `dry-${Date.now().toString(36)}${Math.floor(this.random() * 1e4)}` };
  }

  async uploadListingImage(listingId: string, imageUrl: string) {
    this.calls.push({ op: "uploadListingImage", payload: { listingId, imageUrl } });
  }

  async uploadListingFile(listingId: string, file: { name: string; url: string }) {
    this.calls.push({ op: "uploadListingFile", payload: { listingId, ...file } });
  }

  async activateListing(listingId: string) {
    this.calls.push({ op: "activateListing", payload: { listingId } });
  }

  /** Simulates 1–2 new paid receipts spread across published listings. */
  async getReceipts({
    candidates,
    simulateAtLeastOne,
  }: {
    since: Date;
    candidates: ReceiptCandidate[];
    simulateAtLeastOne?: boolean;
  }): Promise<EtsyReceipt[]> {
    if (candidates.length === 0) return [];
    if (!simulateAtLeastOne && this.random() > 0.3) return [];
    const n = 1 + Math.floor(this.random() * 2);
    return Array.from({ length: n }, (_, i) => {
      const c = candidates[Math.floor(this.random() * candidates.length)];
      const qty = this.random() < 0.1 ? 2 : 1;
      return {
        receiptId: `dry-r-${Date.now().toString(36)}-${i}-${Math.floor(this.random() * 1e6)}`,
        etsyListingId: c.etsyListingId,
        buyerCountry: COUNTRIES[Math.floor(this.random() * COUNTRIES.length)],
        quantity: qty,
        totalChf: c.priceChf * qty,
        createdAt: new Date(),
      };
    });
  }

  async getListingStats(current: { etsyListingId: string; views: number; favorites: number }[]) {
    return Object.fromEntries(
      current.map((l) => [
        l.etsyListingId,
        { views: l.views + Math.floor(this.random() * 25), favorites: l.favorites + (this.random() < 0.3 ? 1 : 0) },
      ]),
    );
  }
}
