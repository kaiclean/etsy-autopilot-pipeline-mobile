import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { getSuppliers } from "@/adapters/supplier";
import { storeSupplierProduct } from "@/adapters/supplier/catalog";
import type { Supplier, SupplierProduct, SupplierQuote } from "@/adapters/supplier/types";
import type { DB } from "@/db";
import { sourcingChoices, supplierQuotes } from "@/db/schema";
import { raiseSourcingAlert } from "@/lib/alerts";
import { isPodPreset, type PodPreset } from "@/lib/fees";
import { getSetting } from "@/lib/settings";
import {
  defaultSourcingRegion, quoteCountry, quoteIsFresh, recheckSupplier, resolveSourcedCost,
  selectSupplier, SOURCING_REGIONS, switchThreshold,
  sameSupplier,
  type SourcingChoice, type SourcingQuote, type SourcingRegion,
} from "@/lib/sourcing";
import type { StageContext } from "./types";

/** 0015 is deliberately manual, not journaled. Existing installations continue using estimates. */
export async function sourcingAvailable(db: DB) {
  const result = await db.execute(sql`select
    to_regclass('public.supplier_quotes') is not null and
    to_regclass('public.sourcing_choices') is not null and
    exists (select 1 from information_schema.columns where table_name = 'supplier_quotes' and column_name = 'destination_country') and
    exists (select 1 from information_schema.columns where table_name = 'orders' and column_name = 'sourcing_recheck')
    as available`);
  return result.rows[0]?.available === true;
}

export async function latestQuotes(db: DB, preset: PodPreset, region: SourcingRegion, country?: string): Promise<SourcingQuote[]> {
  const rows = await db.selectDistinctOn([supplierQuotes.supplier, supplierQuotes.providerRef])
    .from(supplierQuotes).where(and(eq(supplierQuotes.preset, preset), eq(supplierQuotes.region, region),
      country ? eq(supplierQuotes.destinationCountry, country) : isNull(supplierQuotes.destinationCountry)))
    .orderBy(supplierQuotes.supplier, supplierQuotes.providerRef, desc(supplierQuotes.fetchedAt), desc(supplierQuotes.id));
  return rows.map((row) => ({ ...row, preset, region, currency: row.currency ?? "", sourceUrl: row.sourceUrl ?? "" }));
}

async function currentChoice(db: DB, preset: PodPreset, region: SourcingRegion) {
  const [choice] = await db.select().from(sourcingChoices)
    .where(and(eq(sourcingChoices.preset, preset), eq(sourcingChoices.region, region)));
  return choice ?? null;
}

type FetchOptions = {
  suppliers: Supplier[];
  now: Date;
  force?: boolean;
  country?: string;
  log: (message: string, level?: "info" | "warn" | "error") => void;
};

function completedAt(start: Date) {
  return new Date(Math.max(start.getTime(), Date.now()));
}

/** Only catalog/pricing reads; no supplier write methods are used here. */
export async function fetchQuotes(db: DB, preset: PodPreset, region: SourcingRegion, opts: FetchOptions) {
  const cached = opts.force ? [] : await latestQuotes(db, preset, region, opts.country);
  const quotes: SourcingQuote[] = [];
  for (const supplier of opts.suppliers) {
    const prior = cached.filter((row) => row.supplier === supplier.id);
    if (prior.length && prior.every((row) => quoteIsFresh(row.fetchedAt, opts.now))) {
      quotes.push(...prior);
      continue;
    }
    let products: SupplierProduct[];
    try {
      products = await supplier.listProducts(preset);
    } catch {
      opts.log(`${supplier.id}:${preset} catalog unavailable; stock and cost remain —`, "warn");
      products = [];
    }
    const candidates = products.length ? products : [{
      supplier: supplier.id, preset, uid: "", title: preset, baseCostUsd: null, currency: null,
      sourceUrl: supplier.id === "printify" ? "https://api.printify.com/v1/catalog/blueprints.json" : "https://product.gelatoapis.com/v3/catalogs",
      fetchedAt: opts.now,
    }];
    for (const product of candidates) {
      let quote: SupplierQuote = {
        inStock: null, baseCostUsd: null, shippingUsd: null, productionDays: null,
        currency: "USD", sourceUrl: product.sourceUrl, fetchedAt: opts.now,
      };
      if (product.uid) {
        try {
          quote = await supplier.quote(product, opts.country ?? quoteCountry(region));
          await storeSupplierProduct(db, { ...product, baseCostUsd: quote.baseCostUsd, currency: quote.currency, sourceUrl: quote.sourceUrl, fetchedAt: quote.fetchedAt });
        } catch {
          opts.log(`${supplier.id}:${preset}:${product.uid} quote unavailable; stock and cost remain —`, "warn");
        }
      }
      const [stored] = await db.insert(supplierQuotes).values({
        ...quote, supplier: supplier.id, preset, region, destinationCountry: opts.country ?? null, providerRef: product.uid || null,
      }).returning();
      quotes.push({ ...stored, preset, region, currency: stored.currency ?? "", sourceUrl: stored.sourceUrl ?? "" });
    }
  }
  return quotes;
}

export async function refreshSourcing(ctx: Pick<StageContext, "db" | "now" | "log" | "shopId" | "demo">, suppliers = getSuppliers()) {
  if (!await sourcingAvailable(ctx.db)) {
    ctx.log("Sourcing unavailable: apply drizzle/0015_sourcing.sql manually; pricing remains an estimate.", "warn");
    return { comparisons: 0, alerts: 0, available: false };
  }
  const settings = await getSetting(ctx.db, "podProducts");
  let comparisons = 0;
  let alerts = 0;
  for (const preset of settings.enabledPresets) {
    for (const region of SOURCING_REGIONS) {
      const quotes = await fetchQuotes(ctx.db, preset, region, { suppliers, now: ctx.now, log: ctx.log });
      const chosenAt = completedAt(ctx.now);
      const selected = selectSupplier(quotes, await currentChoice(ctx.db, preset, region), chosenAt);
      if (selected.alert) {
        alerts++;
        await raiseSourcingAlert(ctx.db, { preset, region, reason: selected.reason, shopId: ctx.shopId, demo: ctx.demo });
        ctx.log(`${preset}/${region}: ${selected.reason}`, "warn");
      } else if (selected.choice) {
        const values = { preset, region, ...selected.choice, reason: selected.reason, chosenAt };
        await ctx.db.insert(sourcingChoices).values(values).onConflictDoUpdate({
          target: [sourcingChoices.preset, sourcingChoices.region], set: values,
        });
      }
      comparisons++;
    }
  }
  return { comparisons, alerts, available: true };
}

export async function sourcedListingCosts(db: DB, presets: readonly PodPreset[], now = new Date()) {
  const costs: Partial<Record<PodPreset, number | null>> = {};
  const products: Partial<Record<PodPreset, SupplierProduct>> = {};
  const suppliers: Partial<Record<PodPreset, string>> = {};
  const estimates: Partial<Record<PodPreset, boolean>> = {};
  const available = await sourcingAvailable(db);
  const region = defaultSourcingRegion((await getSetting(db, "sourcing")).defaultRegion);
  for (const preset of presets) {
    const choice = available ? await currentChoice(db, preset, region) : null;
    const quote = choice ? (await latestQuotes(db, preset, region)).find((row) => sameSupplier(row, choice)) : null;
    const resolved = resolveSourcedCost(preset, quote, now);
    costs[preset] = resolved.podCostChf;
    estimates[preset] = resolved.estimate;
    if (choice) suppliers[preset] = choice.supplier;
    if (choice && quote && !resolved.estimate && choice.providerRef && (choice.supplier === "printify" || choice.supplier === "gelato")) {
      products[preset] = {
        supplier: choice.supplier, preset, uid: choice.providerRef, title: preset,
        baseCostUsd: quote.baseCostUsd, currency: quote.currency, sourceUrl: quote.sourceUrl, fetchedAt: quote.fetchedAt,
        ...(choice.supplier === "printify" ? {
          blueprintId: Number(choice.providerRef.split(":")[0]),
          printProviderId: Number(choice.providerRef.split(":")[1]),
          variantId: Number(choice.providerRef.split(":")[2]),
        } : {}),
      };
    }
  }
  return { costs, products, suppliers, estimates };
}

export async function recheckOrderSourcing(
  ctx: Pick<StageContext, "db" | "now" | "log" | "shopId" | "demo">,
  input: { preset: PodPreset; region: SourcingRegion; country: string; current: SourcingChoice },
  suppliers = getSuppliers(),
) {
  const quotes = await fetchQuotes(ctx.db, input.preset, input.region, {
    suppliers, now: ctx.now, log: ctx.log, force: true, country: input.country,
  });
  const checkedAt = completedAt(ctx.now);
  // Older listings store a blueprint/provider pair, rather than the full variant UID.
  const matches = input.current.providerRef?.split(":").length === 2
    ? quotes.filter((quote) => quote.supplier === input.current.supplier && quote.providerRef?.startsWith(`${input.current.providerRef}:`))
    : [];
  const current = matches.length === 1 ? { ...input.current, providerRef: matches[0].providerRef } : input.current;
  const decision = recheckSupplier(quotes, current, checkedAt, switchThreshold());
  ctx.log(`DRY-RUN sourcing ${input.preset}/${input.country}: ${decision.reason} No supplier order was placed or moved.`, decision.alert ? "warn" : "info");
  if (decision.switched || decision.alert) {
    await raiseSourcingAlert(ctx.db, { ...input, reason: `DRY-RUN: ${decision.reason}`, shopId: ctx.shopId, demo: ctx.demo, switched: decision.switched });
  }
  return { ...decision, dryRun: true as const, checkedAt: checkedAt.toISOString() };
}

export function listingPreset(provider: string | null) {
  const preset = provider?.split(":")[1];
  return preset && isPodPreset(preset) ? preset : null;
}
