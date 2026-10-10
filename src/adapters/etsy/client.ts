import { loadArtworkBytes, ownMediaKey, renderArtworkPreview, isPreviewUrl } from "@/lib/artwork-source";
import { config } from "@/lib/config";
import { describeFetchError } from "@/lib/http-error";
import { localAssetPng } from "@/lib/png";
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
    private shopIdOverride?: string,
  ) {}

  private get shopId() {
    const id = this.shopIdOverride || config.etsy.shopId;
    if (!id) throw new Error("ETSY_SHOP_ID missing");
    return id;
  }

  private async authHeaders() {
    if (Date.now() > this.tokens.expiresAt) {
      if (!this.tokens.refreshToken) {
        const refreshError = "Etsy refresh token missing";
        this.tokens = { ...this.tokens, refreshError };
        await this.saveTokens(this.tokens);
        throw new Error(refreshError);
      }
      try {
        const next = await refreshTokens(this.tokens.refreshToken);
        this.tokens = { ...next, refreshError: null };
        await this.saveTokens(this.tokens);
      } catch (error) {
        const status = error instanceof Error ? error.message.match(/\b(\d{3})\b/)?.[1] : undefined;
        const refreshError = status ? `Etsy token refresh failed (HTTP ${status})` : "Etsy token refresh failed";
        this.tokens = { ...this.tokens, refreshError };
        await this.saveTokens(this.tokens);
        throw new Error(refreshError);
      }
    }
    const { apiKey, sharedSecret } = config.etsy;
    return {
      "x-api-key": `${apiKey}:${sharedSecret}`,
      Authorization: `Bearer ${this.tokens.accessToken}`,
    };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const method = init.method ?? "GET";
    let res: Response;
    try {
      res = await fetch(`${API}${path}`, {
        ...init,
        headers: { ...(await this.authHeaders()), ...(init.headers ?? {}) },
      });
    } catch (error) {
      throw describeFetchError(error, `Etsy ${method} ${path}`);
    }
    if (!res.ok) throw new Error(`Etsy ${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 400)}`);
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

  /** Own placeholder art is rendered here. Fetching it through the public tunnel throws "fetch failed". */
  private async fetchBlob(url: string) {
    if (isPreviewUrl(url)) {
      // A live gallery is the real artwork, downscaled. The flat niche card is never sent to Etsy.
      const preview = await renderArtworkPreview(url);
      if (!preview) throw new Error(`Gallery preview has no loadable artwork (${url.slice(0, 120)}). Configure S3 or Blob storage and regenerate the design.`);
      return new Blob([new Uint8Array(preview)], { type: "image/png" });
    }
    const artwork = url.startsWith("data:") || ownMediaKey(url) ? await loadArtworkBytes(url) : null;
    if (artwork) return new Blob([new Uint8Array(artwork)], { type: "image/png" });
    const png = localAssetPng(url);
    if (png) return new Blob([new Uint8Array(png)], { type: "image/png" });
    let res: Response;
    try {
      res = await fetch(sameHostLoopback(url));
    } catch (error) {
      throw describeFetchError(error, `Could not download asset ${url}`);
    }
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

  async activateListing(listingId: string) {
    const body = new URLSearchParams({ state: "active" });
    await this.request(`/shops/${this.shopId}/listings/${listingId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
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

/** Fetch this app's own files on loopback so the server does not call its public tunnel. */
function sameHostLoopback(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const hosts = new Set(["localhost", "127.0.0.1"]);
  if (process.env.APP_URL) {
    try {
      hosts.add(new URL(process.env.APP_URL).host);
    } catch {
      /* ignore a bad APP_URL */
    }
  }
  if (process.env.VERCEL_URL) hosts.add(process.env.VERCEL_URL);
  if (!hosts.has(parsed.host)) return url;
  const port = process.env.PORT || "4317";
  return `http://127.0.0.1:${port}${parsed.pathname}${parsed.search}`;
}
