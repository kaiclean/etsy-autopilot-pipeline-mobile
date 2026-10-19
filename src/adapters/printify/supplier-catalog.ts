import { blueprintRows, providerRows, variantRows, type VariantRow } from "./catalog";

/** Read-only supplier survey for the four live POD products. Never returns or logs the token. */
const API = "https://api.printify.com";

export type SupplierPreset = "posterA3" | "posterA2" | "mug" | "tshirt" | "sweatshirt";

const SURVEY: Record<SupplierPreset, { blueprint: RegExp; avoid?: RegExp; variant: RegExp; maxVariants: number }> = {
  posterA3: { blueprint: /poster/i, avoid: /canvas|framed|frame|metal|wood|acrylic|hanger|glossy|satin|silk|magnet|sticker|puzzle|calendar/i, variant: /\bA3\b|297\s*[x×]\s*420|11\.7\S*\s*[x×]\s*16\.5/i, maxVariants: 2 },
  posterA2: { blueprint: /poster/i, avoid: /canvas|framed|frame|metal|wood|acrylic|hanger|glossy|satin|silk|magnet|sticker|puzzle|calendar/i, variant: /\bA2\b|420\s*[x×]\s*594|16\.5\S*\s*[x×]\s*23\.4/i, maxVariants: 2 },
  mug: { blueprint: /^(?:ceramic )?mug(?: \(?11\s?oz\)?)?$|ceramic mug.*11|mug 11\s?oz|white glossy mug|accent coffee mug/i, avoid: /travel|tumbler|latte|magic|enamel|color changing|15\s?oz/i, variant: /11\s?oz/i, maxVariants: 1 },
  tshirt: { blueprint: /unisex jersey short sleeve tee|bella.*3001|unisex softstyle t-shirt|unisex heavy cotton tee/i, avoid: /long sleeve|v-neck|youth|kids|tank/i, variant: /(?:white|black).*\b(?:M)\b|\bM\b.*(?:white|black)/i, maxVariants: 2 },
  sweatshirt: { blueprint: /unisex heavy blend.*crewneck sweatshirt|crewneck sweatshirt/i, avoid: /youth|kids|hoodie|zip|garment-dyed|premium/i, variant: /(?:white|black).*\b(?:M)\b|\bM\b.*(?:white|black)/i, maxVariants: 2 },
};

export type SupplierCatalogRow = {
  preset: SupplierPreset;
  blueprintId: number;
  blueprint: string;
  brand?: string;
  model?: string;
  printProviderId: number;
  provider: string;
  providerLocation: string | null;
  variantId: number;
  variant: string;
  /** Printify base cost in the account currency (cents), when the catalog or an existing shop product exposes it. */
  baseCost: number | null;
  baseCostSource: "catalog" | "shop-product" | null;
  shipToCh: { firstItem: number; additionalItem: number | null; currency: string; handling: string | null; source: string } | null;
  inStock: boolean | null;
};

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null;

function variantText(row: VariantRow) {
  return `${row.title} ${Object.values(row.options ?? {}).join(" ")}`.replace(/["″]/g, "");
}

export async function surveyPrintifySuppliers(token: string, opts: { shopId?: string; presets?: SupplierPreset[]; fetchImpl?: typeof fetch; maxBlueprints?: number; maxProviders?: number; delayMs?: number } = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const headers = { Authorization: ["Bearer", token].join(" "), "User-Agent": "EtsyAutopilot", Accept: "application/json" };
  const errors: string[] = [];
  async function read(path: string): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, opts.delayMs ?? 250));
      const res = await fetchImpl(`${API}${path}`, { headers, signal: AbortSignal.timeout(20_000) });
      if (res.status === 429 && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 5000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) throw new Error(`GET ${path.replace(/\?.*$/, "")} HTTP ${res.status}`);
      return res.json();
    }
  }
  async function safe<T>(path: string, fallback: T): Promise<unknown | T> {
    try {
      return await read(path);
    } catch (error) {
      errors.push(error instanceof Error ? error.message.split(token).join("[redacted]") : "request failed");
      return fallback;
    }
  }

  // Base costs from products already created in the shop (Printify's catalog v1 does not publish cost).
  const shopCosts = new Map<string, number>();
  if (opts.shopId && /^\d+$/.test(opts.shopId)) {
    for (let page = 1; page <= 5; page++) {
      const payload = await safe(`/v1/shops/${opts.shopId}/products.json?limit=50&page=${page}`, null);
      const data = isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];
      for (const product of data.filter(isRecord)) {
        for (const variant of (Array.isArray(product.variants) ? product.variants : []).filter(isRecord)) {
          if (typeof variant.id === "number" && typeof variant.cost === "number") {
            shopCosts.set(`${product.blueprint_id}:${product.print_provider_id}:${variant.id}`, variant.cost);
          }
        }
      }
      if (!isRecord(payload) || payload.last_page === page || data.length < 50) break;
    }
  }

  const blueprints = blueprintRows(await read("/v1/catalog/blueprints.json"));
  const locations = new Map<number, string | null>();
  const rows: SupplierCatalogRow[] = [];
  for (const preset of opts.presets ?? (Object.keys(SURVEY) as SupplierPreset[])) {
    const rule = SURVEY[preset];
    const matches = blueprints.filter((row) => rule.blueprint.test(row.title) && !(rule.avoid?.test(row.title))).slice(0, opts.maxBlueprints ?? (preset.startsWith("poster") ? 6 : 3));
    for (const blueprint of matches) {
      const full = blueprints.find((row) => row.id === blueprint.id) as unknown as Json;
      const providers = providerRows(await safe(`/v1/catalog/blueprints/${blueprint.id}/print_providers.json`, [])).slice(0, opts.maxProviders ?? 25);
      for (const provider of providers) {
        if (!locations.has(provider.id)) {
          const detail = await safe(`/v1/catalog/print_providers/${provider.id}.json`, null);
          const loc = isRecord(detail) && isRecord(detail.location) ? detail.location : null;
          locations.set(provider.id, loc ? [loc.city, loc.region, loc.country].filter((part) => typeof part === "string" && part).join(", ") || null : null);
        }
        const base = `/v1/catalog/blueprints/${blueprint.id}/print_providers/${provider.id}`;
        const variants = variantRows(await safe(`${base}/variants.json?show-out-of-stock=1`, []))
          .filter((row) => rule.variant.test(variantText(row)))
          .slice(0, rule.maxVariants);
        if (!variants.length) continue;
        const v2 = await safe(`/v2/catalog/blueprints/${blueprint.id}/print_providers/${provider.id}/shipping/standard.json`, null);
        const v2rows = isRecord(v2) && Array.isArray(v2.data) ? v2.data.filter(isRecord) : [];
        const v1 = v2rows.length ? null : await safe(`${base}/shipping.json`, null);
        for (const variant of variants) {
          const raw = variant as unknown as Json;
          let ship: SupplierCatalogRow["shipToCh"] = null;
          const v2hit = v2rows.map((row) => (isRecord(row.attributes) ? row.attributes : row)).find((attr) =>
            isRecord(attr.country) && attr.country.code === "CH" && attr.variantId === variant.id);
          if (v2hit && isRecord(v2hit.shippingCost)) {
            const first = isRecord(v2hit.shippingCost.firstItem) ? v2hit.shippingCost.firstItem : null;
            const extra = isRecord(v2hit.shippingCost.additionalItems) ? v2hit.shippingCost.additionalItems : null;
            const handling = isRecord(v2hit.handlingTime) ? `${v2hit.handlingTime.from}-${v2hit.handlingTime.to} days` : null;
            if (first && typeof first.amount === "number") {
              ship = { firstItem: first.amount, additionalItem: extra && typeof extra.amount === "number" ? extra.amount : null, currency: String(first.currency ?? "USD"), handling, source: "v2 standard CH" };
            }
          }
          if (!ship && isRecord(v1) && Array.isArray(v1.profiles)) {
            const profiles = v1.profiles.filter(isRecord).filter((profile) => Array.isArray(profile.variant_ids) && profile.variant_ids.includes(variant.id));
            const profile = profiles.find((p) => Array.isArray(p.countries) && p.countries.includes("CH"))
              ?? profiles.find((p) => Array.isArray(p.countries) && p.countries.includes("REST_OF_THE_WORLD"));
            if (profile && isRecord(profile.first_item) && typeof profile.first_item.cost === "number") {
              ship = {
                firstItem: profile.first_item.cost,
                additionalItem: isRecord(profile.additional_items) && typeof profile.additional_items.cost === "number" ? profile.additional_items.cost : null,
                currency: String(profile.first_item.currency ?? "USD"),
                handling: isRecord(v1.handling_time) ? `${v1.handling_time.value} ${v1.handling_time.unit}` : null,
                source: Array.isArray(profile.countries) && profile.countries.includes("CH") ? "v1 CH" : "v1 rest of world",
              };
            }
          }
          const catalogCost = typeof raw.cost === "number" ? raw.cost : typeof raw.price === "number" ? raw.price : null;
          const shopCost = shopCosts.get(`${blueprint.id}:${provider.id}:${variant.id}`) ?? null;
          rows.push({
            preset, blueprintId: blueprint.id, blueprint: blueprint.title,
            brand: typeof full?.brand === "string" ? full.brand : undefined,
            model: typeof full?.model === "string" ? full.model : undefined,
            printProviderId: provider.id, provider: provider.title, providerLocation: locations.get(provider.id) ?? null,
            variantId: variant.id, variant: variant.title,
            baseCost: catalogCost ?? shopCost, baseCostSource: catalogCost != null ? "catalog" : shopCost != null ? "shop-product" : null,
            shipToCh: ship,
            inStock: typeof raw.is_available === "boolean" ? raw.is_available : typeof raw.is_enabled === "boolean" ? raw.is_enabled : null,
          });
        }
      }
    }
  }
  return { readOnly: true as const, rows, errors: [...new Set(errors)].slice(0, 20) };
}
