import { config } from "@/lib/config";
import type { EtsyTokens } from "@/lib/settings";
import { refreshTokens } from "./oauth";
import type { EtsyAdapter, EtsyDraftInput, EtsyReceipt } from "./types";

const API = "https://openapi.etsy.com/v3/application";

type RawMoney = { amount: number; divisor?: number };
type RawTransaction = { transaction_id: number; listing_id: number; quantity?: number; price?: RawMoney };
type RawReceipt = { receipt_id: number; country_iso?: string; created_timestamp: number; transactions?: RawTransaction[] };
type RawListing = { listing_id: number; views?: number; num_favorers?: number };

/** Live Etsy Open API v3 client. Token persistence is injected so refreshes are saved. */
export class EtsyLiveClient implements EtsyAdapter {
  readonly mode = "live" as const;

  constructor(
    private tokens: EtsyTokens,
    private saveTokens: (t: EtsyTokens) => Promise<void>,
  ) {}

  private get shopId() {
    const id = config.etsy.shopId;
    if (!id) throw new Error("ETSY_SHOP_ID missing");
    return id;
  }

  private async authHeaders() {
    if (Date.now() > this.tokens.expiresAt) {
      this.tokens = await refreshTokens(this.tokens.refreshToken);
      await this.saveTokens(this.tokens);
    }
    const { apiKey, sharedSecret } = config.etsy;
    return {
      "x-api-key": `${apiKey}:${sharedSecret}`,
      Authorization: `Bearer ${this.tokens.accessToken}`,
    };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: { ...(await this.authHeaders()), ...(init.headers ?? {}) },
    });
    if (!res.ok) throw new Error(`Etsy ${init.method ?? "GET"} ${path} → ${res.status}: ${(await res.text()).slice(0, 400)}`);
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }

  async createDraftListing(input: EtsyDraftInput) {
    const body = new URLSearchParams({
      quantity: String(input.quantity ?? 999),
      title: input.title,
      description: input.description,
      price: input.priceChf.toFixed(2),
      who_made: "i_did",
      when_made: "made_to_order",
      taxonomy_id: String(input.type === "download" ? config.etsy.taxonomyDigital : config.etsy.taxonomyPoster),
      type: input.type,
      is_supply: "false",
    });
    input.tags.forEach((t) => body.append("tags", t));
    const json = await this.request<{ listing_id: number }>(`/shops/${this.shopId}/listings`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    return { listingId: String(json.listing_id) };
  }

  private async fetchBlob(url: string) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not download asset ${url}: ${res.status}`);
    return res.blob();
  }

  async uploadListingImage(listingId: string, imageUrl: string) {
    const form = new FormData();
    form.append("image", await this.fetchBlob(imageUrl), "image.png");
    await this.request(`/shops/${this.shopId}/listings/${listingId}/images`, { method: "POST", body: form });
  }

  async uploadListingFile(listingId: string, file: { name: string; url: string }) {
    const form = new FormData();
    form.append("file", await this.fetchBlob(file.url), file.name);
    form.append("name", file.name);
    await this.request(`/shops/${this.shopId}/listings/${listingId}/files`, { method: "POST", body: form });
  }

  async getReceipts({ since }: { since: Date }): Promise<EtsyReceipt[]> {
    const minCreated = Math.floor(since.getTime() / 1000);
    const json = await this.request<{ results: RawReceipt[] }>(
      `/shops/${this.shopId}/receipts?min_created=${minCreated}&limit=100&was_paid=true`,
    );
    const out: EtsyReceipt[] = [];
    for (const r of json.results ?? []) {
      for (const t of r.transactions ?? []) {
        const amount = (t.price?.amount ?? 0) / (t.price?.divisor ?? 100);
        out.push({
          receiptId: `${r.receipt_id}-${t.transaction_id}`,
          etsyListingId: String(t.listing_id),
          buyerCountry: r.country_iso ?? "??",
          quantity: t.quantity ?? 1,
          totalChf: amount * (t.quantity ?? 1),
          createdAt: new Date(r.created_timestamp * 1000),
        });
      }
    }
    return out;
  }

  async getListingStats(current: { etsyListingId: string }[]) {
    const listingIds = current.map((c) => c.etsyListingId).filter((id) => !id.startsWith("dry-"));
    const out: Record<string, { views: number; favorites: number }> = {};
    for (let i = 0; i < listingIds.length; i += 100) {
      const batch = listingIds.slice(i, i + 100);
      const json = await this.request<{ results: RawListing[] }>(`/listings/batch?listing_ids=${batch.join(",")}`);
      for (const l of json.results ?? []) {
        out[String(l.listing_id)] = { views: l.views ?? 0, favorites: l.num_favorers ?? 0 };
      }
    }
    return out;
  }
}
