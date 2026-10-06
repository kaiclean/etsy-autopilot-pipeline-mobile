import type { VariantRow } from "@/adapters/printify/catalog";
import { pickPricedVariantIds, pickVariantIds } from "@/adapters/printify/catalog";
import {
  POD_FALLBACK_NOTE,
  POD_PRESETS,
  podCostChf,
  round2,
  suggestPrice,
  usdToChf,
  type PodPreset,
  type PriceOpts,
} from "@/lib/fees";

export type ShippingDestination = "CH" | "EU" | "REST_OF_THE_WORLD";

export type PodVariantQuote = {
  id: number;
  title: string;
  blankChf: number;
  shippingChf: number;
  costChf: number;
  priceChf: number;
  shippingDestination: ShippingDestination | null;
};

export type PodCostQuote = {
  preset: PodPreset;
  source: "printify" | "fallback";
  /** Cost of the variant whose price is shown on the listing. */
  costChf: number;
  primaryVariantId: number | null;
  variants: PodVariantQuote[];
  blueprintId: number | null;
  printProviderId: number | null;
  shopCurrency: string | null;
  /** True when Printify did not confirm the shop currency and costs were read as CHF. */
  assumedShopCurrencyChf: boolean;
  note: string;
};

const EU = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LT", "LV", "LU", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK", "ES",
]);

type ShippingProfile = {
  variant_ids?: number[];
  countries?: string[];
  first_item?: { cost?: number; currency?: string };
};

export function fallbackPodQuote(preset: PodPreset, fxRate?: number): PodCostQuote {
  return {
    preset,
    source: "fallback",
    costChf: podCostChf(preset, fxRate),
    primaryVariantId: null,
    variants: [],
    blueprintId: null,
    printProviderId: null,
    shopCurrency: null,
    assumedShopCurrencyChf: true,
    note: POD_FALLBACK_NOTE,
  };
}

function minorToMajor(cost: number) {
  return round2(cost / 100);
}

function moneyToChf(cost: number | undefined, currency: string | undefined, fxRate: number): number | null {
  if (typeof cost !== "number" || !Number.isFinite(cost)) return null;
  const major = Number.isInteger(cost) ? minorToMajor(cost) : round2(cost);
  const code = (currency ?? "").toUpperCase();
  if (code === "CHF") return major;
  if (code === "USD") return round2(usdToChf(major, fxRate));
  return null;
}

function profileMatches(profile: ShippingProfile, variantId: number, destination: ShippingDestination) {
  const ids = profile.variant_ids ?? [];
  if (ids.length > 0 && !ids.includes(variantId)) return false;
  const countries = (profile.countries ?? []).map((c) => c.toUpperCase());
  if (destination === "CH") return countries.includes("CH");
  if (destination === "EU") return countries.some((c) => EU.has(c));
  return countries.includes("REST_OF_THE_WORLD");
}

export function pickShipping(
  profiles: ShippingProfile[],
  variantId: number,
  fxRate: number,
): { shippingChf: number; destination: ShippingDestination } | null {
  for (const destination of ["CH", "EU", "REST_OF_THE_WORLD"] as const) {
    const profile = profiles.find((item) => profileMatches(item, variantId, destination));
    if (!profile) continue;
    const shippingChf = moneyToChf(profile.first_item?.cost, profile.first_item?.currency, fxRate);
    if (shippingChf == null) continue;
    return { shippingChf, destination };
  }
  return null;
}

function blankChf(cost: number | undefined, shopCurrency: string | null, fxRate: number): number | null {
  if (typeof cost !== "number" || !Number.isFinite(cost)) return null;
  const major = Number.isInteger(cost) ? minorToMajor(cost) : round2(cost);
  if (shopCurrency == null) return major;
  const code = shopCurrency.toUpperCase();
  if (code === "CHF") return major;
  if (code === "USD") return round2(usdToChf(major, fxRate));
  return null;
}

export function quoteFromPrintify(input: {
  preset: PodPreset;
  shopCurrency: string | null;
  blueprintId: number;
  printProviderId: number;
  providerTitle?: string;
  variants: VariantRow[];
  shippingProfiles: ShippingProfile[];
  fxRate: number;
  priceOpts: Omit<PriceOpts, "podCostChf" | "productType">;
}): PodCostQuote {
  const fallback = fallbackPodQuote(input.preset, input.fxRate);
  const shop = input.shopCurrency?.toUpperCase() ?? null;
  if (shop != null && shop !== "CHF" && shop !== "USD") {
    return { ...fallback, shopCurrency: shop, assumedShopCurrencyChf: false, note: `${POD_FALLBACK_NOTE} Printify reported shop currency ${shop}, which this shop does not convert.` };
  }
  const ids = pickPricedVariantIds(input.preset, input.variants);
  const byId = new Map(input.variants.map((row) => [row.id, row]));
  const variants: PodVariantQuote[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) continue;
    const blank = blankChf(row.cost, shop, input.fxRate);
    const shipping = pickShipping(input.shippingProfiles, id, input.fxRate);
    if (blank == null || !shipping || shipping.destination === "REST_OF_THE_WORLD") continue;
    const costChf = round2(blank + shipping.shippingChf);
    const priceChf = suggestPrice({ ...input.priceOpts, podCostChf: costChf, productType: "pod" });
    variants.push({
      id,
      title: row.title,
      blankChf: blank,
      shippingChf: shipping.shippingChf,
      costChf,
      priceChf,
      shippingDestination: shipping.destination,
    });
  }
  if (variants.length === 0) {
    return {
      ...fallback,
      blueprintId: input.blueprintId,
      printProviderId: input.printProviderId,
      shopCurrency: shop,
      assumedShopCurrencyChf: shop == null,
      note: `${POD_FALLBACK_NOTE} Printify blueprint ${input.blueprintId} / provider ${input.printProviderId} had no variant cost with CH or EU shipping.`,
    };
  }
  const primaryId = pickVariantIds(input.preset, input.variants)[0];
  const primary = variants.find((variant) => variant.id === primaryId) ?? variants[0];
  const destinations = [...new Set(variants.map((variant) => variant.shippingDestination))].filter(Boolean).join(", ");
  const currencyNote =
    shop === "CHF"
      ? "Printify shop currency is CHF."
      : shop === "USD"
        ? "Printify shop currency is USD; blank cost was converted to CHF."
        : "Printify shop currency was not returned; blank cost is assumed to be CHF.";
  return {
    preset: input.preset,
    source: "printify",
    costChf: primary.costChf,
    primaryVariantId: primary.id,
    variants,
    blueprintId: input.blueprintId,
    printProviderId: input.printProviderId,
    shopCurrency: shop,
    assumedShopCurrencyChf: shop == null,
    note: `Printify blueprint ${input.blueprintId} / provider ${input.printProviderId}${input.providerTitle ? ` (${input.providerTitle})` : ""}. Blank + ${destinations} shipping, per variant. ${currencyNote}`,
  };
}

/** Recompute retail prices for a cached cost quote. Costs stay; prices follow the niche band. */
export function repriceQuote(quote: PodCostQuote, priceOpts: Omit<PriceOpts, "podCostChf" | "productType">): PodCostQuote {
  if (quote.variants.length === 0) return quote;
  const variants = quote.variants.map((variant) => ({
    ...variant,
    priceChf: suggestPrice({ ...priceOpts, podCostChf: variant.costChf, productType: "pod" }),
  }));
  const primary = variants.find((variant) => variant.id === quote.primaryVariantId) ?? variants[0];
  return { ...quote, variants, costChf: primary.costChf };
}

/** Each enabled variant gets its own .90 price. A shared price is never used when it breaks that variant's floor. */
export function pricesForVariantCosts(
  variants: { id: number; costChf: number }[],
  priceOpts: Omit<PriceOpts, "podCostChf" | "productType">,
) {
  return variants.map((variant) => ({
    id: variant.id,
    costChf: variant.costChf,
    priceChf: suggestPrice({ ...priceOpts, podCostChf: variant.costChf, productType: "pod" }),
  }));
}

type OrderLine = { cost?: number; shipping_cost?: number; quantity?: number };

/** Supplier cost from a Printify order payload. Null when the cost fields are absent. */
export function printifyOrderCostChf(payload: unknown, fxRate: number): { costChf: number; assumedChf: boolean; currency: string | null } | null {
  if (typeof payload !== "object" || payload == null) return null;
  const order = payload as { currency?: string; line_items?: OrderLine[] };
  const lines = Array.isArray(order.line_items) ? order.line_items : [];
  let minor = 0;
  let found = false;
  for (const line of lines) {
    const qty = line.quantity && line.quantity > 0 ? line.quantity : 1;
    if (typeof line.cost === "number") {
      minor += line.cost * qty;
      found = true;
    }
    if (typeof line.shipping_cost === "number") {
      minor += line.shipping_cost;
      found = true;
    }
  }
  if (!found) return null;
  const currency = order.currency?.toUpperCase() ?? null;
  const major = round2(minor / 100);
  if (currency === "USD") return { costChf: round2(usdToChf(major, fxRate)), assumedChf: false, currency };
  if (currency != null && currency !== "CHF") return null;
  return { costChf: major, assumedChf: currency == null, currency };
}
