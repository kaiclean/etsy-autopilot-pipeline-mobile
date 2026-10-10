import type { PodPreset } from "@/lib/fees";
import { config } from "@/lib/config";
import { GelatoDryRunSupplier } from "./gelato-dryrun";
import { SupplierHttp } from "./http";
import type { SupplierProduct, SupplierQuote } from "./types";

const PRODUCTS = "https://product.gelatoapis.com/v3";
const ORDERS = "https://order.gelatoapis.com/v4";
const CATALOG_TITLES: Record<PodPreset, RegExp> = {
  posterA3: /\bposters?\b/i, mug: /\bmugs?\b/i, tshirt: /t-?shirts?|\btees?\b/i,
  sweatshirt: /sweatshirts?|crewneck/i, tote: /\btote\b/i, phoneCase: /phone cases?/i,
  canvas: /\bcanvas\b/i, sticker: /\bstickers?\b/i, blanket: /\bblankets?\b/i,
  hoodie: /hoodies?|hooded sweatshirts?/i, ornament: /\bornaments?\b/i,
};

/** Official catalog/pricing and order reads. Product/order creation remains simulated. */
export class GelatoSupplier extends GelatoDryRunSupplier {
  private productsHttp: SupplierHttp;
  private ordersHttp: SupplierHttp;
  private catalogs?: Promise<{ catalogUid: string; title: string }[]>;
  private products = new Map<string, Promise<SupplierProduct[]>>();

  constructor(fetchImpl: typeof fetch = fetch) {
    super();
    const headers = { "X-API-KEY": config.gelato.apiKey ?? "" };
    this.productsHttp = new SupplierHttp(PRODUCTS, headers, fetchImpl);
    this.ordersHttp = new SupplierHttp(ORDERS, headers, fetchImpl);
  }

  // Source: https://dashboard.gelato.com/docs/products/catalog/list/
  override async listProducts(preset?: PodPreset): Promise<SupplierProduct[]> {
    if (!config.gelato.apiKey) return [];
    const key = preset ?? "all";
    if (!this.products.has(key)) this.products.set(key, this.readProducts(preset).catch((error) => { this.products.delete(key); throw error; }));
    return this.products.get(key)!;
  }

  private async readProducts(preset?: PodPreset): Promise<SupplierProduct[]> {
    this.catalogs ??= this.productsHttp.request<{ catalogUid: string; title: string }[]>("/catalogs")
      .catch((error) => { this.catalogs = undefined; throw error; });
    const catalogs = await this.catalogs;
    if (!Array.isArray(catalogs)) throw new Error("Invalid Gelato catalog response");
    const matches = catalogs.filter((row) => row && typeof row.catalogUid === "string" && typeof row.title === "string" && (!preset || CATALOG_TITLES[preset].test(row.title)));
    const out: SupplierProduct[] = [];
    for (const catalog of matches) {
      const p = preset ?? (Object.keys(CATALOG_TITLES) as PodPreset[]).find((item) => CATALOG_TITLES[item].test(catalog.title));
      if (!p) continue;
      // Source: https://dashboard.gelato.com/docs/products/product/search/
      const path = `/catalogs/${encodeURIComponent(catalog.catalogUid)}/products:search`;
      for (let offset = 0; offset < 500; offset += 100) {
        const payload = await this.productsHttp.request<{ products?: { productUid?: string; attributes?: Record<string, string> }[] }>(path, { limit: 100, offset });
        if (!Array.isArray(payload.products)) throw new Error("Invalid Gelato product response");
        for (const row of payload.products) {
          if (!row || typeof row.productUid !== "string" || !row.productUid) continue;
          const attributes = Object.values(row.attributes ?? {}).filter((value) => typeof value === "string").join(" · ");
          out.push({
            supplier: this.id, preset: p, uid: row.productUid, title: [catalog.title, attributes].filter(Boolean).join(" · "),
            baseCostUsd: null, currency: null, sourceUrl: `${PRODUCTS}${path}`, fetchedAt: new Date(),
          });
        }
        if (payload.products.length < 100) break;
      }
    }
    return out;
  }

  // Source: https://dashboard.gelato.com/docs/products/prices/
  override async quote(product: SupplierProduct, region: string): Promise<SupplierQuote> {
    if (product.supplier !== this.id || !product.uid || !/^[A-Z]{2}$/.test(region)) throw new Error("Invalid Gelato quote input");
    if (!config.gelato.apiKey) return super.quote(product, region);
    const path = `/products/${encodeURIComponent(product.uid)}/prices?country=${region}&currency=USD`;
    const rows = await this.productsHttp.request<{ productUid: string; country: string; quantity: number; price: number; currency: string }[]>(path);
    if (!Array.isArray(rows)) throw new Error("Invalid Gelato prices response");
    const price = rows.find((row) => row && row.productUid === product.uid && row.country === region && row.quantity === 1 && row.currency === "USD" && Number.isFinite(row.price) && row.price >= 0);
    // v4 orders:quote needs an actual recipient address and artwork. A region alone
    // cannot establish shipping; never fabricate an address or a landed total.
    return { baseCostUsd: price?.price ?? null, shippingUsd: null, currency: "USD", sourceUrl: `${PRODUCTS}${path}`, fetchedAt: new Date() };
  }

  // Source: https://dashboard.gelato.com/docs/orders/v4/get/
  override async getOrderStatuses(orderIds: string[]) {
    const out: Record<string, "pending" | "in_production" | "shipped" | "delivered"> = {};
    for (const id of orderIds) {
      if (id.startsWith("dry-")) { out[id] = "pending"; continue; }
      if (!config.gelato.apiKey) throw new Error("GELATO_API_KEY missing");
      const order = await this.ordersHttp.request<{ fulfillmentStatus?: string }>(`/orders/${encodeURIComponent(id)}`);
      out[id] = order.fulfillmentStatus === "delivered" ? "delivered"
        : order.fulfillmentStatus === "shipped" || order.fulfillmentStatus === "in_transit" ? "shipped"
          : order.fulfillmentStatus === "in_production" || order.fulfillmentStatus === "printed" ? "in_production" : "pending";
    }
    return out;
  }
}
