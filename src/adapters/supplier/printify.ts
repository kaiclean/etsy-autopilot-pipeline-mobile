import { createHash } from "node:crypto";
import { PrintifyLiveClient } from "@/adapters/printify/client";
import { PrintifyDryRunAdapter } from "@/adapters/printify/dryrun";
import { blueprintRows, pickBlueprint, pickProvider, pickVariantIds, providerRows, variantRows } from "@/adapters/printify/catalog";
import type { PrintifyAdapter } from "@/adapters/printify/types";
import { config, hasPrintifyCredentials } from "@/lib/config";
import { isPodPreset, POD_PRESETS, type PodPreset } from "@/lib/fees";
import { SupplierHttp } from "./http";
import type { Supplier, SupplierProduct, SupplierProductInput, SupplierQuote } from "./types";

const API = "https://api.printify.com/v1";

/** Existing Printify adapter stays intact. This issue exposes only dry-run creation. */
export class PrintifySupplier implements Supplier {
  readonly id = "printify" as const;
  readonly mode = "dry-run" as const;
  private adapter: PrintifyAdapter;
  private http: SupplierHttp;
  private catalog = new Map<PodPreset, Promise<SupplierProduct[]>>();
  private blueprints?: ReturnType<SupplierHttp["request"]>;
  private costs = new Map<string, number>();

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
    const provider = pickProvider(providerRows(await this.http.request(`/catalog/blueprints/${blueprint.id}/print_providers.json`)));
    if (!provider) return [];
    const variantsUrl = `${API}/catalog/blueprints/${blueprint.id}/print_providers/${provider.id}/variants.json`;
    const variants = variantRows(await this.http.request(variantsUrl.slice(API.length)));
    const variantId = pickVariantIds(preset, variants)[0];
    if (variantId == null) return [];
    const shippingUrl = `${API}/catalog/blueprints/${blueprint.id}/print_providers/${provider.id}/shipping.json`;
    const shipping = await this.http.request<{ profiles?: { variant_ids?: number[]; countries?: string[]; first_item?: { cost?: number; currency?: string } }[] }>(shippingUrl.slice(API.length));
    for (const profile of shipping.profiles ?? []) {
      if (!profile.variant_ids?.includes(variantId) || profile.first_item?.currency !== "USD") continue;
      const cents = profile.first_item.cost;
      if (typeof cents !== "number" || !Number.isFinite(cents) || cents < 0) continue;
      for (const country of profile.countries ?? []) this.costs.set(`${blueprint.id}:${provider.id}:${variantId}:${country}`, cents / 100);
    }
    // Catalog variants do not establish a landed cost. A missing quote remains unknown.
    return [{
      supplier: this.id, preset, uid: `${blueprint.id}:${provider.id}:${variantId}`, title: blueprint.title,
      baseCostUsd: null, currency: null, sourceUrl: shippingUrl, fetchedAt: new Date(),
      blueprintId: blueprint.id, printProviderId: provider.id, variantId,
    }];
  }

  async quote(product: SupplierProduct, region: string): Promise<SupplierQuote> {
    if (product.supplier !== this.id || !/^[A-Z]{2}$/.test(region)) throw new Error("Invalid Printify quote input");
    // Plan estimates in fees.ts are not live supplier quotes.
    return { baseCostUsd: null, shippingUsd: this.costs.get(`${product.uid}:${region}`) ?? this.costs.get(`${product.uid}:REST_OF_THE_WORLD`) ?? null, currency: "USD", sourceUrl: product.sourceUrl, fetchedAt: new Date() };
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
