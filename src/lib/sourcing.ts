import type { SupplierQuote } from "@/adapters/supplier/types";
import { podCostChf, usdToChf, type PodPreset } from "@/lib/fees";

export const SOURCING_REGIONS = ["CH", "EU", "US"] as const;
export type SourcingRegion = typeof SOURCING_REGIONS[number];
export const QUOTE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const EU_COUNTRIES = new Set("AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE".split(" "));

/** EU comparisons use Germany as the representative destination, not a fabricated EU address. */
export function quoteCountry(region: SourcingRegion) {
  return region === "EU" ? "DE" : region;
}

export function buyerRegion(country: string): SourcingRegion | null {
  const code = country.toUpperCase();
  return code === "CH" || code === "US" ? code : EU_COUNTRIES.has(code) ? "EU" : null;
}

export function defaultSourcingRegion(value = process.env.SOURCING_DEFAULT_REGION): SourcingRegion {
  return SOURCING_REGIONS.find((region) => region === value?.toUpperCase()) ?? "CH";
}

export function switchThreshold(value = process.env.SOURCING_SWITCH_THRESHOLD_PCT) {
  const number = value?.trim() ? Number(value) : 10;
  return Number.isFinite(number) && number >= 0 ? number : 10;
}

export type SourcingQuote = SupplierQuote & {
  id?: number;
  supplier: string;
  preset: PodPreset;
  region: SourcingRegion;
  providerRef: string | null;
};

export type SourcingChoice = {
  supplier: string;
  providerRef: string | null;
  landedCostChf: number | null;
  quoteId?: number | null;
};

export function quoteIsFresh(fetchedAt: Date, now = new Date()) {
  const age = now.getTime() - fetchedAt.getTime();
  return Number.isFinite(age) && age >= 0 && age <= QUOTE_MAX_AGE_MS;
}

export function landedCostChf(quote: Pick<SupplierQuote, "baseCostUsd" | "shippingUsd" | "currency">): number | null {
  if (quote.currency !== "USD" || quote.baseCostUsd == null || quote.shippingUsd == null ||
    !Number.isFinite(quote.baseCostUsd) || !Number.isFinite(quote.shippingUsd) ||
    quote.baseCostUsd < 0 || quote.shippingUsd < 0) return null;
  const cost = usdToChf(quote.baseCostUsd + quote.shippingUsd);
  return Number.isFinite(cost) ? cost : null;
}

export function sameSupplier(a: Pick<SourcingChoice, "supplier" | "providerRef">, b: Pick<SourcingChoice, "supplier" | "providerRef">) {
  return a.supplier === b.supplier && a.providerRef === b.providerRef;
}

function choiceFromQuote(quote: SourcingQuote): SourcingChoice {
  return { supplier: quote.supplier, providerRef: quote.providerRef, landedCostChf: landedCostChf(quote), quoteId: quote.id ?? null };
}

export function selectSupplier(quotes: readonly SourcingQuote[], current: SourcingChoice | null = null, now = new Date()) {
  const eligible = quotes.filter((quote) => quote.inStock === true && quoteIsFresh(quote.fetchedAt, now) && landedCostChf(quote) != null);
  eligible.sort((a, b) => landedCostChf(a)! - landedCostChf(b)! ||
    (a.productionDays ?? Infinity) - (b.productionDays ?? Infinity) ||
    a.supplier.localeCompare(b.supplier) || (a.providerRef ?? "").localeCompare(b.providerRef ?? ""));
  const best = eligible[0];
  return best
    ? { choice: choiceFromQuote(best), alert: false, reason: "Cheapest verified in-stock landed cost; production time breaks ties." }
    : { choice: current, alert: true, reason: "No fresh, verified in-stock quote with a complete landed cost; keeping current supplier." };
}

/** Read-only recommendation. Callers must never use this decision to move or place a live order. */
export function recheckSupplier(quotes: readonly SourcingQuote[], current: SourcingChoice, now = new Date(), thresholdPct = 10) {
  const quote = quotes.find((row) => sameSupplier(row, current) && quoteIsFresh(row.fetchedAt, now));
  const cost = quote ? landedCostChf(quote) : null;
  const increase = current.landedCostChf != null && current.landedCostChf >= 0 && cost != null &&
    cost > current.landedCostChf * (1 + thresholdPct / 100);
  if (quote?.inStock === false || increase) {
    const selected = selectSupplier(quotes.filter((row) => !sameSupplier(row, current)), current, now);
    return { ...selected, reason: `${quote?.inStock === false ? "Current supplier is out of stock" : `Cost increased by more than ${thresholdPct}%`}. ${selected.reason}`, switched: !!selected.choice && !sameSupplier(selected.choice, current) };
  }
  if (quote?.inStock !== true || cost == null) {
    return { choice: current, alert: true, switched: false, reason: "Current stock or landed cost is unknown; keeping current supplier for review." };
  }
  return { choice: choiceFromQuote(quote), alert: false, switched: false, reason: "Current supplier remains in stock and within the cost threshold." };
}

export function resolveSourcedCost(preset: PodPreset, quote?: SourcingQuote | null, now = new Date()) {
  const sourced = quote && quote.inStock === true && quoteIsFresh(quote.fetchedAt, now) ? landedCostChf(quote) : null;
  return { podCostChf: sourced ?? podCostChf(preset), estimate: sourced == null };
}
