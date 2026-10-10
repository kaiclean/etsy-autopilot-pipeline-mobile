import { createHash } from "node:crypto";
import { PrintifyLiveClient } from "@/adapters/printify/client";
import { PrintifyDryRunAdapter } from "@/adapters/printify/dryrun";
import { blueprintRows, pickBlueprint, pickVariantIds, providerRows, variantRows } from "@/adapters/printify/catalog";
import type { PrintifyAdapter } from "@/adapters/printify/types";
import { config, hasPrintifyCredentials } from "@/lib/config";
import { isPodPreset, POD_PRESETS, type PodPreset } from "@/lib/fees";
import { SupplierHttp } from "./http";
import type { Supplier, SupplierProduct, SupplierProductInput, SupplierQuote } from "./types";

const API = "https://api.printify.com/v1";
type QuoteVariant = { id: number; cost?: number; currency?: string; is_available?: boolean };
type Shipping = {
  handling_time?: { value?: number; unit?: string };
  profiles?: { variant_ids?: number[]; countries?: string[]; first_item?: { cost?: number; currency?: string } }[];
};

function usdCost(cents: unknown, currency: string = "USD"): number | null {
  return currency === "USD" && typeof cents === "number" && Number.isFinite(cents) && cents >= 0 ? cents / 100 : null;
}

/** Existing Printify adapter stays intact. This issue exposes only dry-run creation. */
export class PrintifySupplier implements Supplier {
  readonly id = "printify" as const;
  readonly mode = "dry-run" as const;
  private adapter: PrintifyAdapter;
  private http: SupplierHttp;
  private catalog = new Map<PodPreset, Promise<SupplierProduct[]>>();
  private blueprints?: ReturnType<SupplierHttp["request"]>;

  constructor(fetchImpl: typeof fetch = fetch) {
    this.adapter = new PrintifyDryRunAdapter(() => 1);
    this.http = new SupplierHttp(API, { Authorization: ["Bearer", config.printify.token ?? ""].join(" "), "User-Agent": "EtsyAutopilot" }, fetchImpl);
  }

  async listProducts(preset?: PodPreset): Promise<SupplierProduct[]> {
    const presets = preset ? [preset] : Object.keys(POD_PRESETS).filter(isPodPreset);
    const out: SupplierProduct[] = [];
    for (const p of presets) {
      if (!hasPrintifyCredentials()) continue;
      if (!this.catalog.has(p)) this.catalog.set(p, this.readProduct(p).catch((error) => { this.catalog.delete(p); throw error; }));
      out.push(...await this.catalog.get(p)!);
    }
    return out;
  }

  private async readProduct(preset: PodPreset): Promise<SupplierProduct[]> {
    this.blueprints ??= this.http.request("/catalog/blueprints.json").catch((error) => { this.blueprints = undefined; throw error; });
    const blueprint = pickBlueprint(preset, blueprintRows(await this.blueprints));
    if (!blueprint) return [];
    const providers = providerRows(await this.http.request(`/catalog/blueprints/${blueprint.id}/print_providers.json`));
    const out: SupplierProduct[] = [];
    for (const provider of providers) {
      const path = `/catalog/blueprints/${blueprint.id}/print_providers/${provider.id}`;
      const variants = variantRows(await this.http.request(`${path}/variants.json?show-out-of-stock=1`).catch(() => null));
      const variantId = pickVariantIds(preset, variants)[0];
      if (variantId == null) continue;
      await this.http.request<Shipping>(`${path}/shipping.json`).catch(() => null);
      // Keep each provider candidate, including unknown or unavailable variants.
      // Only a fresh quote can establish stock and landed cost for selection.
      out.push({
        supplier: this.id, preset, uid: `${blueprint.id}:${provider.id}:${variantId}`, title: `${blueprint.title} · ${provider.title}`,
        baseCostUsd: null, currency: null, sourceUrl: `${API}${path}/shipping.json`, fetchedAt: new Date(),
        blueprintId: blueprint.id, printProviderId: provider.id, variantId,
      });
    }
    return out;
  }

  async quote(product: SupplierProduct, region: string): Promise<SupplierQuote> {
    if (product.supplier !== this.id || !/^[A-Z]{2}$/.test(region)) throw new Error("Invalid Printify quote input");
    let baseCostUsd: number | null = null;
    let shippingUsd: number | null = null;
    let inStock: boolean | null = null;
    let productionDays: number | null = null;
    let sourceUrl = product.sourceUrl;
    if (hasPrintifyCredentials() && product.blueprintId != null && product.printProviderId != null && product.variantId != null) {
      const path = `/catalog/blueprints/${product.blueprintId}/print_providers/${product.printProviderId}`;
      sourceUrl = `${API}${path}/variants.json?show-out-of-stock=1`;
      const variants = variantRows(await this.http.request(`${path}/variants.json?show-out-of-stock=1`).catch(() => null)) as QuoteVariant[];
      const variant = variants.find((row) => row.id === product.variantId);
      baseCostUsd = usdCost(variant?.cost, variant?.currency);
      inStock = typeof variant?.is_available === "boolean" ? variant.is_available : null;
      const shipping = await this.http.request<Shipping>(`${path}/shipping.json`).catch(() => null);
      const handling = shipping?.handling_time;
      if ((handling?.unit === "day" || handling?.unit === "days") && typeof handling.value === "number" && Number.isInteger(handling.value) && handling.value >= 0) {
        productionDays = handling.value;
      }
      const profiles = (shipping?.profiles ?? []).filter((row) => row.variant_ids?.includes(product.variantId!));
      const profile = profiles.find((row) => row.countries?.includes(region))
        ?? profiles.find((row) => row.countries?.includes("REST_OF_THE_WORLD"));
      shippingUsd = profile?.first_item?.currency === "USD" ? usdCost(profile.first_item.cost) : null;
      if (baseCostUsd == null || inStock == null) {
        const existing = (await this.readShopProducts().catch(() => [])).find((row) => row.blueprint_id === product.blueprintId && row.print_provider_id === product.printProviderId);
        if (existing) {
          const url = `${API}/shops/${encodeURIComponent(config.printify.shopId!)}/products/${encodeURIComponent(existing.id)}.json`;
          // Source: https://developers.printify.com/#products — cost is USD cents;
          // price is the seller's retail price, never a production cost.
          const payload = await this.http.request<{ variants?: QuoteVariant[] }>(url.slice(API.length)).catch(() => null);
          const shopVariant = payload?.variants?.find((row) => row.id === product.variantId);
          const cost = usdCost(shopVariant?.cost, shopVariant?.currency);
          if (baseCostUsd == null && cost != null) { baseCostUsd = cost; sourceUrl = url; }
          if (inStock == null && typeof shopVariant?.is_available === "boolean") { inStock = shopVariant.is_available; sourceUrl = url; }
        }
      }
    }
    return { baseCostUsd, shippingUsd, inStock, productionDays, currency: "USD", sourceUrl, fetchedAt: new Date() };
  }

  private async readShopProducts() {
    const out: { id: string; blueprint_id: number; print_provider_id: number }[] = [];
    for (let page = 1; page <= 10; page++) {
      const payload = await this.http.request<{ data?: { id: string; blueprint_id: number; print_provider_id: number }[]; last_page?: number }>(
        `/shops/${encodeURIComponent(config.printify.shopId!)}/products.json?limit=100&page=${page}`,
      );
      if (!Array.isArray(payload.data)) throw new Error("Invalid Printify products response");
      out.push(...payload.data.filter((row) => row && typeof row.id === "string" && typeof row.blueprint_id === "number" && typeof row.print_provider_id === "number")
        .map(({ id, blueprint_id, print_provider_id }) => ({ id, blueprint_id, print_provider_id })));
      if (payload.data.length < 100 || (typeof payload.last_page === "number" && page >= payload.last_page)) break;
    }
    return out;
  }

  async createProduct(input: SupplierProductInput) {
    const hash = createHash("sha256").update(JSON.stringify([input.preset, input.title, input.imageUrl])).digest("hex").slice(0, 24);
    return this.adapter.createAndPublish({
      ...input, existingProductId: `dry-pfy-${hash}`, publishToEtsy: false,
    });
  }

  async getOrderStatuses(orderIds: string[]) {
    const real = orderIds.filter((id) => !id.startsWith("dry-"));
    const simulated = Object.fromEntries(orderIds.filter((id) => id.startsWith("dry-")).map((id) => [id, "pending" as const]));
    if (!real.length) return simulated;
    if (!hasPrintifyCredentials()) throw new Error("Printify credentials missing");
    return { ...simulated, ...await new PrintifyLiveClient().getOrderStatuses(real) };
  }
}
