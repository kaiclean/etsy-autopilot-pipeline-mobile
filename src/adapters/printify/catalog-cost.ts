import { blueprintRows, pickBlueprint, pickProvider, providerRows, variantRows } from "@/adapters/printify/catalog";
import { config } from "@/lib/config";
import type { PriceOpts, PodPreset } from "@/lib/fees";
import { fallbackPodQuote, quoteFromPrintify, repriceQuote, type PodCostQuote } from "@/lib/pod-cost";

const API = "https://api.printify.com/v1";
const PRESETS: PodPreset[] = ["posterA3", "mug", "tshirt", "sweatshirt"];

type ShopRow = { id?: number | string; currency?: string };

async function printifyGet(path: string, token: string): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": "EtsyAutopilot" },
  });
  if (!res.ok) throw new Error(`Printify GET ${path} → ${res.status}`);
  return res.json();
}

function shopCurrency(payload: unknown, shopId: string) {
  const rows = Array.isArray(payload) ? payload : [];
  const shop = rows.find((row): row is ShopRow => {
    if (typeof row !== "object" || row == null) return false;
    return String((row as ShopRow).id ?? "") === shopId;
  });
  return shop?.currency ?? null;
}

/**
 * Read-only Printify catalog quote. Never calls a write endpoint.
 * Falls back to the labelled Printful/US estimate when the token, cost, or CH/EU shipping is missing.
 */
export async function fetchPodQuote(preset: PodPreset, fxRate: number, priceOpts: Omit<PriceOpts, "podCostChf" | "productType">): Promise<PodCostQuote> {
  const token = config.printify.token;
  const shopId = config.printify.shopId;
  if (!token || !shopId) return fallbackPodQuote(preset, fxRate);
  try {
    const shops = await printifyGet("/shops.json", token);
    const currency = shopCurrency(shops, shopId);
    const envBlueprint = config.printify.blueprintId;
    const envProvider = config.printify.printProviderId;
    const envVariants = config.printify.variantIds;
    let blueprintId = envBlueprint;
    let providerId = envProvider;
    let providerTitle: string | undefined;
    if (!blueprintId || !providerId) {
      const blueprints = blueprintRows(await printifyGet("/catalog/blueprints.json", token));
      const blueprint = pickBlueprint(preset, blueprints);
      if (!blueprint) return fallbackPodQuote(preset, fxRate);
      blueprintId = blueprint.id;
      const providers = providerRows(await printifyGet(`/catalog/blueprints/${blueprint.id}/print_providers.json`, token));
      const provider = pickProvider(providers);
      if (!provider) return fallbackPodQuote(preset, fxRate);
      providerId = provider.id;
      providerTitle = provider.title;
    }
    const variantPayload = await printifyGet(`/catalog/blueprints/${blueprintId}/print_providers/${providerId}/variants.json?show-out-of-stock=0`, token);
    const shippingPayload = (await printifyGet(
      `/catalog/blueprints/${blueprintId}/print_providers/${providerId}/shipping.json`,
      token,
    )) as { profiles?: [] };
    let variants = variantRows(variantPayload);
    if (envVariants.length > 0) {
      const wanted = new Set(envVariants);
      const matched = variants.filter((row) => wanted.has(row.id));
      if (matched.length > 0) variants = matched;
    }
    return quoteFromPrintify({
      preset,
      shopCurrency: currency,
      blueprintId,
      printProviderId: providerId,
      providerTitle,
      variants,
      shippingProfiles: shippingPayload.profiles ?? [],
      fxRate,
      priceOpts,
    });
  } catch {
    return fallbackPodQuote(preset, fxRate);
  }
}

const cache = new Map<string, PodCostQuote>();

export async function loadPodQuotes(fxRate: number, priceOpts: Omit<PriceOpts, "podCostChf" | "productType">) {
  const out = {} as Record<PodPreset, PodCostQuote>;
  for (const preset of PRESETS) {
    const key = `${preset}:${fxRate}`;
    let quote = cache.get(key);
    if (!quote) {
      quote = await fetchPodQuote(preset, fxRate, priceOpts);
      cache.set(key, quote);
    }
    out[preset] = repriceQuote(quote, priceOpts);
  }
  return out;
}
