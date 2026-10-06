import { config } from "@/lib/config";
import { describeFetchError } from "@/lib/http-error";
import { localAssetPng } from "@/lib/png";
import type { EtsyTokens } from "@/lib/settings";
import { refreshTokens } from "./oauth";
import { collectPages } from "@/lib/pagination";
import { mapReceipt } from "./receipts";
import type { EtsyAdapter, EtsyDraftInput, EtsyLedgerEntry, EtsyReceipt } from "./types";

const API = "https://openapi.etsy.com/v3/application";

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
    const pages = await collectPages(async (offset) => {
      const json = await this.request<{ results?: unknown[] }>(
        `/shops/${this.shopId}/receipts?min_created=${minCreated}&limit=100&offset=${offset}&was_paid=true`,
      );
      return json.results ?? [];
    });
    return pages.flatMap((row) => mapReceipt(row));
  }

  async getLedgerEntries({ since, until }: { since: Date; until: Date }): Promise<EtsyLedgerEntry[]> {
    const minCreated = Math.floor(since.getTime() / 1000);
    const maxCreated = Math.floor(until.getTime() / 1000);
    return collectPages(async (offset) => {
      const json = await this.request<{ results?: EtsyLedgerEntry[] }>(
        `/shops/${this.shopId}/payment-account/ledger-entries?min_created=${minCreated}&max_created=${maxCreated}&limit=100&offset=${offset}`,
      );
      return json.results ?? [];
    });
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
