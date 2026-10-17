import { loadArtworkBytes, ownMediaKey, renderArtworkPreview, isPreviewUrl } from "@/lib/artwork-source";
import { inspectArtwork } from "@/lib/artwork-codec";
import { config } from "@/lib/config";
import { describeFetchError } from "@/lib/http-error";
import { localAssetPng } from "@/lib/png";
import type { EtsyTokens } from "@/lib/settings";
import { refreshTokens } from "./oauth";
import { etsyMoneyInChf, validateEtsyMoney } from "./money";
import { EtsyAmbiguousWriteError, etsyRequest } from "./transport";
import type { components } from "./generated";
import { findSellerTaxonomy } from "./taxonomy";
import type { EtsyAdapter, EtsyDraftInput, EtsyListingStats, EtsyReceipt } from "./types";

const API = "https://openapi.etsy.com/v3/application";

type RawReceipt = components["schemas"]["ShopReceipt"];
type RawListing = components["schemas"]["ShopListing"] & { views?: unknown };
const refreshFlights = new Map<string, Promise<EtsyTokens>>();

function numericId(value: string) {
  if (!/^\d+$/.test(value)) throw new Error("Invalid Etsy resource id");
  return value;
}

function counter(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Live Etsy Open API v3 client. Token persistence is injected so refreshes are saved. */
export class EtsyLiveClient implements EtsyAdapter {
  readonly mode = "live" as const;

  constructor(
    private tokens: EtsyTokens,
    private saveTokens: (t: EtsyTokens, expected?: EtsyTokens) => Promise<EtsyTokens | null | void>,
    private shopIdOverride?: string,
    private loadTokens?: () => Promise<EtsyTokens | null>,
    private refreshLease?: <T>(work: () => Promise<T>) => Promise<T>,
  ) {}

  private get shopId() {
    const id = this.shopIdOverride || config.etsy.shopId;
    if (!id) throw new Error("ETSY_SHOP_ID missing");
    return numericId(id);
  }

  private async authHeaders() {
    const stored = await this.loadTokens?.();
    if (stored) this.tokens = stored;
    if (Date.now() > this.tokens.expiresAt) {
      if (!this.tokens.refreshToken) {
        const refreshError = "Etsy refresh token missing";
        this.tokens = { ...this.tokens, refreshError };
        await this.saveTokens(this.tokens);
        throw new Error(refreshError);
      }
      const current = this.tokens;
      const key = `${this.shopId}:${current.userId ?? ""}`;
      try {
        let flight = refreshFlights.get(key);
        if (!flight) {
          const refresh = async () => {
            const latest = await this.loadTokens?.();
            if (latest && latest.expiresAt > Date.now()) return latest;
            const expected = latest ?? current;
            const next = { ...(await refreshTokens(expected.refreshToken)), refreshError: null };
            return (await this.saveTokens(next, expected)) ?? next;
          };
          flight = this.refreshLease ? this.refreshLease(refresh) : refresh();
          refreshFlights.set(key, flight);
        }
        try {
          this.tokens = await flight;
        } finally {
          if (refreshFlights.get(key) === flight) refreshFlights.delete(key);
        }
        if (this.tokens.expiresAt <= Date.now()) throw new Error("Etsy refresh did not produce a current token");
      } catch (error) {
        const status = error instanceof Error ? error.message.match(/\b(\d{3})\b/)?.[1] : undefined;
        const refreshError = status ? `Etsy token refresh failed (HTTP ${status})` : "Etsy token refresh failed";
        const failedTokens = { ...current, refreshError };
        this.tokens = (await this.saveTokens(failedTokens, current)) ?? failedTokens;
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
    return etsyRequest<T>(`${API}${path}`, init, {
      apiKey: `${config.etsy.apiKey}:${config.etsy.sharedSecret}`,
      headers: () => this.authHeaders(),
    });
  }

  async createDraftListing(input: EtsyDraftInput) {
    const name = input.type === "download" ? "ETSY_TAXONOMY_ID_DIGITAL" : "ETSY_TAXONOMY_ID_POSTER";
    const taxonomyId = Number(process.env[name]);
    if (!Number.isSafeInteger(taxonomyId) || taxonomyId <= 0) throw new Error(`${name} must explicitly select a seller taxonomy before live draft creation`);
    const taxonomy = await this.request<components["schemas"]["SellerTaxonomyNodes"]>("/seller-taxonomy/nodes");
    const selected = findSellerTaxonomy(taxonomy.results ?? [], taxonomyId);
    if (!selected || selected.children?.length) throw new Error("Select an existing leaf seller taxonomy before creating an Etsy draft");
    const shop = await this.request<components["schemas"]["Shop"]>(`/shops/${this.shopId}`);
    if (String(shop.shop_id) !== this.shopId || shop.currency_code !== "CHF") {
      throw new Error("Live CHF draft pricing requires a verified CHF Etsy shop; automatic foreign-currency pricing is not enabled");
    }
    const body = new URLSearchParams({
      quantity: String(input.quantity ?? 999),
      title: input.title,
      description: input.description,
      price: input.priceChf.toFixed(2),
      who_made: "i_did",
      when_made: "made_to_order",
      taxonomy_id: String(taxonomyId),
      type: input.type,
      is_supply: "false",
    });
    input.tags.forEach((t) => body.append("tags", t));
    const json = await this.request<{ listing_id: number } | null>(`/shops/${this.shopId}/listings`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!json || !Number.isSafeInteger(json.listing_id) || json.listing_id <= 0) throw new EtsyAmbiguousWriteError();
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
    if (artwork) {
      const info = await inspectArtwork(artwork);
      if (!info) throw new Error("Etsy upload artwork is invalid or unsupported");
      return new Blob([new Uint8Array(artwork)], { type: `image/${info.format}` });
    }
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
    numericId(listingId);
    const form = new FormData();
    form.append("image", await this.fetchBlob(imageUrl), "image.png");
    await this.request(`/shops/${this.shopId}/listings/${listingId}/images`, { method: "POST", body: form });
  }

  async uploadListingFile(listingId: string, file: { name: string; url: string }) {
    numericId(listingId);
    const form = new FormData();
    form.append("file", await this.fetchBlob(file.url), file.name);
    form.append("name", file.name);
    await this.request(`/shops/${this.shopId}/listings/${listingId}/files`, { method: "POST", body: form });
  }

  async activateListing(listingId: string) {
    numericId(listingId);
    const body = new URLSearchParams({ state: "active" });
    await this.request(`/shops/${this.shopId}/listings/${listingId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  }

  async getReceipts({ since }: { since: Date }): Promise<EtsyReceipt[]> {
    if (!Number.isFinite(since.getTime())) throw new Error("Invalid Etsy receipt cursor");
    const query = new URLSearchParams({
      min_last_modified: String(Math.max(946684800, Math.floor(since.getTime() / 1000))),
      // Modification time filters eligibility; immutable IDs keep edits from moving receipts between pages.
      limit: "100", sort_on: "receipt_id", sort_order: "asc",
    });
    const out: EtsyReceipt[] = [];
    const seen = new Set<number | undefined>();
    for (let offset = 0; offset < 100_000; offset += 100) {
      query.set("offset", String(offset));
      const json = await this.request<{ count?: number; results: RawReceipt[] }>(`/shops/${this.shopId}/receipts?${query}`);
      if (!Array.isArray(json.results)) throw new Error("Etsy receipts response is invalid");
      let added = 0;
      for (const receipt of json.results) {
        if (seen.has(receipt.receipt_id)) continue;
        seen.add(receipt.receipt_id);
        out.push(...this.receiptLines(receipt));
        added++;
      }
      if (json.results.length && !added) throw new Error("Etsy receipt pagination did not advance");
      if (json.results.length < 100) return out;
    }
    throw new Error("Etsy receipt backfill exceeds the per-run limit; narrow the backfill window");
  }

  async getReceipt(receiptId: string) {
    const receipt = await this.request<RawReceipt>(`/shops/${this.shopId}/receipts/${numericId(receiptId)}`);
    if (String(receipt.receipt_id) !== receiptId) throw new Error("Etsy returned a different receipt");
    return this.receiptLines(receipt);
  }

  async getListing(listingId: string) {
    const row = await this.request<RawListing>(`/listings/${numericId(listingId)}`);
    if (!Number.isSafeInteger(row.shop_id) || !Number.isSafeInteger(row.listing_id) ||
      String(row.shop_id) !== this.shopId || String(row.listing_id) !== listingId || typeof row.state !== "string") {
      throw new Error("Etsy listing does not belong to this shop");
    }

    const modified = row.updated_timestamp ?? row.last_modified_timestamp;
    return {
      listingId, shopId: this.shopId, state: row.state, quantity: row.quantity, title: row.title,
      updatedAt: typeof modified === "number" && Number.isFinite(modified) ? new Date(modified * 1000) : undefined,
    };
  }

  async getTaxonomyProperties(taxonomyId: number) {
    if (!Number.isSafeInteger(taxonomyId) || taxonomyId <= 0) throw new Error("Invalid Etsy taxonomy id");
    return this.request<components["schemas"]["TaxonomyNodeProperties"]>(
      `/seller-taxonomy/nodes/${taxonomyId}/properties?supports_variations=true`,
    );
  }

  private receiptLines(r: RawReceipt): EtsyReceipt[] {
    const created = r.created_timestamp ?? r.create_timestamp;
    if (!Number.isSafeInteger(r.receipt_id) || r.receipt_id! <= 0 || !Number.isSafeInteger(created) ||
        created! < 946684800 ||
        !Array.isArray(r.transactions)) throw new Error("Etsy receipt is invalid");
    const out: EtsyReceipt[] = [];
      for (const t of r.transactions ?? []) {
        if (!Number.isSafeInteger(t.transaction_id) || t.transaction_id! <= 0 ||
            !Number.isSafeInteger(t.listing_id) || t.listing_id! <= 0 ||
            !Number.isSafeInteger(t.quantity) || t.quantity! <= 0) throw new Error("Etsy receipt transaction is invalid");
        const money = validateEtsyMoney(t.price);
        const converted = etsyMoneyInChf(money);
        out.push({
          receiptId: `${r.receipt_id}-${t.transaction_id}`,
          etsyListingId: String(t.listing_id),
          buyerCountry: r.country_iso ?? "??",
          quantity: t.quantity ?? 1,
          totalChf: converted.amountChf * t.quantity!,
          createdAt: new Date(created! * 1000),
          modifiedAt: new Date((r.updated_timestamp ?? r.update_timestamp ?? created!) * 1000),
          paid: r.is_paid === true,
          canceled: r.status === "canceled",
          refunded: r.status === "fully refunded" || r.status === "partially refunded" || (Array.isArray(r.refunds) && r.refunds.length > 0),
          originalMoney: money, fxRate: converted.rate, fxAsOf: converted.asOf,
        });
      }
    return out;
  }

  async getListingStats(current: { etsyListingId: string }[]) {
    const listingIds = current.map((c) => c.etsyListingId).filter((id) => !id.startsWith("dry-"));
    const out: Record<string, EtsyListingStats> = {};
    for (let i = 0; i < listingIds.length; i += 100) {
      const batch = listingIds.slice(i, i + 100);
      batch.forEach(numericId);
      const json = await this.request<{ results: RawListing[] }>(`/listings/batch?listing_ids=${batch.join(",")}`);
      for (const l of json.results ?? []) {
        out[String(l.listing_id)] = { views: counter(l.views), favorites: counter(l.num_favorers) };
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
