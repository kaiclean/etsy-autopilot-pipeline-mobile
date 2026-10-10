import fs from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq, sql } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Supplier, SupplierProduct } from "@/adapters/supplier/types";
import { SourcingTable } from "@/components/products/sourcing-table";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { usdToChf } from "@/lib/fees";
import { quoteLadder } from "@/lib/pricing-ladder";
import { setSetting } from "@/lib/settings";
import {
  buyerRegion, defaultSourcingRegion, landedCostChf, QUOTE_MAX_AGE_MS, quoteIsFresh,
  recheckSupplier, resolveSourcedCost, selectSupplier, switchThreshold, type SourcingQuote,
} from "@/lib/sourcing";
import { saveReceipts } from "@/pipeline/orders";
import { fetchQuotes, recheckOrderSourcing, refreshSourcing, sourcedListingCosts, sourcingAvailable } from "@/pipeline/sourcing";

const now = new Date("2026-10-10T12:00:00Z");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
});
afterEach(() => vi.useRealTimers());
const quote = (overrides: Partial<SourcingQuote> = {}): SourcingQuote => ({
  supplier: "printify", preset: "mug", region: "CH", providerRef: "1:2:3",
  inStock: true, baseCostUsd: 5, shippingUsd: 3, productionDays: 3,
  currency: "USD", sourceUrl: "https://api.printify.com/v1/catalog", fetchedAt: now, ...overrides,
});
const current = { supplier: "printify", providerRef: "1:2:3", landedCostChf: usdToChf(8) };

describe("sourcing selection", () => {
  it("minimizes landed cost, excludes false/unknown stock and breaks ties by production days", () => {
    const selected = selectSupplier([
      quote({ baseCostUsd: 0, inStock: null }), quote({ baseCostUsd: 0, inStock: false }),
      quote({ supplier: "gelato", providerRef: "slow", productionDays: 5 }),
      quote({ supplier: "gelato", providerRef: "fast", productionDays: 2 }),
      quote({ baseCostUsd: 20 }),
    ], current, now);
    expect(selected.choice).toMatchObject({ supplier: "gelato", providerRef: "fast", landedCostChf: usdToChf(8) });
    expect(selected.alert).toBe(false);
    expect(selectSupplier([quote({ productionDays: null }), quote({ providerRef: "known", productionDays: 10 })], null, now).choice?.providerRef).toBe("known");
  });

  it("keeps the current supplier and alerts when costs, currency, stock or freshness are unknown", () => {
    const invalid = [
      quote({ shippingUsd: null }), quote({ baseCostUsd: NaN }), quote({ baseCostUsd: -1 }),
      quote({ currency: "CHF" }), quote({ fetchedAt: new Date(now.getTime() - QUOTE_MAX_AGE_MS - 1) }),
      quote({ fetchedAt: new Date(now.getTime() + 1) }),
    ];
    expect(selectSupplier(invalid, current, now)).toMatchObject({ choice: current, alert: true });
    expect(selectSupplier([], null, now)).toMatchObject({ choice: null, alert: true });
    expect(quoteIsFresh(new Date(now.getTime() - QUOTE_MAX_AGE_MS), now)).toBe(true);
    expect(landedCostChf(quote())).toBe(usdToChf(8));
    expect(landedCostChf(quote({ currency: "EUR" }))).toBeNull();
  });

  it("rechecks stock and strict cost threshold, never selecting an unknown fallback", () => {
    const fallback = quote({ supplier: "gelato", providerRef: "g", baseCostUsd: 4 });
    expect(recheckSupplier([quote({ inStock: false }), fallback], current, now)).toMatchObject({ switched: true, choice: { supplier: "gelato" } });
    expect(recheckSupplier([quote({ baseCostUsd: 6 }), fallback], current, now)).toMatchObject({ switched: true });
    expect(recheckSupplier([quote({ baseCostUsd: 5.8 }), fallback], current, now)).toMatchObject({ switched: false });
    expect(recheckSupplier([quote({ inStock: null }), fallback], current, now)).toMatchObject({ switched: false, alert: true });
    expect(recheckSupplier([quote({ inStock: false }), { ...fallback, inStock: null }], current, now)).toMatchObject({ switched: false, choice: current, alert: true });
  });

  it("uses fresh sourced costs in pricing and flags preset fallback as an estimate", () => {
    const sourced = resolveSourcedCost("mug", quote(), now);
    expect(sourced).toEqual({ podCostChf: usdToChf(8), estimate: false });
    const ladder = quoteLadder("alpine", ["mug"], { mug: sourced.podCostChf }, { mug: sourced.estimate });
    expect(ladder[2]).toMatchObject({ podCostChf: usdToChf(8), costIsEstimate: false });
    expect(resolveSourcedCost("mug", quote({ fetchedAt: new Date(0) }), now).estimate).toBe(true);
    expect(quoteLadder("alpine", ["mug"])[2].costIsEstimate).toBe(true);
    expect(resolveSourcedCost("tote", null, now)).toEqual({ podCostChf: null, estimate: true });
  });

  it("maps regions and validates environment settings", () => {
    expect(buyerRegion("fr")).toBe("EU");
    expect(buyerRegion("GB")).toBeNull();
    expect(defaultSourcingRegion("EU")).toBe("EU");
    expect(defaultSourcingRegion("invalid")).toBe("CH");
    expect(switchThreshold("")).toBe(10);
    expect(switchThreshold("-1")).toBe(10);
  });

  it("renders unknown dashboard values as — with chosen/source/timestamp metadata", () => {
    const html = renderToStaticMarkup(createElement(SourcingTable, {
      quotes: [quote({ inStock: null, baseCostUsd: null, shippingUsd: null, productionDays: null })],
      choices: [{ ...current, preset: "mug", region: "CH" }], now,
    }));
    expect(html).toContain("—");
    expect(html).not.toContain("null");
    expect(html).toContain("Chosen");
    expect(html).toContain(now.toISOString());
    expect(html).toContain("https://api.printify.com");
  });
});

async function withDb(test: (db: DB, client: PGlite) => Promise<void>) {
  const client = new PGlite("memory://");
  try {
    const db = drizzle(client, { schema }) as DB;
    await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
    await test(db, client);
  } finally { await client.close(); }
}

async function applySourcing(client: PGlite) {
  await client.exec(await fs.readFile(path.join(process.cwd(), "drizzle/0016_sourcing.sql"), "utf8"));
}

function supplierFixture(): Supplier {
  return {
    id: "printify", mode: "dry-run",
    listProducts: vi.fn(async () => [{
      supplier: "printify" as const, preset: "mug" as const, uid: "1:2:3", title: "Mug",
      baseCostUsd: null, currency: null, sourceUrl: quote().sourceUrl, fetchedAt: now,
    }]),
    quote: vi.fn(async () => quote()),
    createProduct: vi.fn(async () => { throw new Error("Supplier writes prohibited"); }),
    getOrderStatuses: vi.fn(async () => ({})),
  };
}

describe("sourcing persistence and dry-run order decisions", () => {
  it("does not auto-run manual migration and preserves estimates until it is applied", async () => withDb(async (db, client) => {
    expect(await sourcingAvailable(db)).toBe(false);
    expect((await sourcedListingCosts(db, ["mug"], now)).estimates.mug).toBe(true);
    await applySourcing(client);
    await applySourcing(client);
    expect(await sourcingAvailable(db)).toBe(true);
  }));

  it("caches fresh quotes, refreshes expired quotes, retains current choice with alert on no candidates", async () => withDb(async (db, client) => {
    await applySourcing(client);
    await setSetting(db, "podProducts", { enabledPresets: ["mug"], suppliers: {} });
    const [shop] = await db.select().from(schema.shops).limit(1);
    const ctx = { db, now, shopId: shop.id, demo: true, log: vi.fn() };
    const supplier = supplierFixture();
    await refreshSourcing(ctx, [supplier]);
    expect(supplier.quote).toHaveBeenCalledTimes(3);
    await refreshSourcing(ctx, [supplier]);
    expect(supplier.quote).toHaveBeenCalledTimes(3);
    expect(await db.select().from(schema.sourcingChoices)).toHaveLength(3);
    expect((await sourcedListingCosts(db, ["mug"], now))).toMatchObject({ costs: { mug: usdToChf(8) }, estimates: { mug: false } });
    expect((await sourcedListingCosts(db, ["mug"], new Date(now.getTime() + QUOTE_MAX_AGE_MS + 1))).estimates.mug).toBe(true);
    vi.mocked(supplier.quote).mockResolvedValue(quote({ inStock: null, fetchedAt: new Date(now.getTime() + QUOTE_MAX_AGE_MS + 1) }));
    const report = await refreshSourcing({ ...ctx, now: new Date(now.getTime() + QUOTE_MAX_AGE_MS + 1) }, [supplier]);
    expect(report.alerts).toBe(3);
    expect(supplier.quote).toHaveBeenCalledTimes(6);
    expect((await db.select().from(schema.sourcingChoices))[0].supplier).toBe("printify");
    expect((await db.select().from(schema.events)).some((event) => event.type === "sourcing.unavailable")).toBe(true);
    await refreshSourcing({ ...ctx, now: new Date(now.getTime() + QUOTE_MAX_AGE_MS + 1) }, [supplier]);
    expect((await db.select().from(schema.events)).filter((event) => event.type === "sourcing.unavailable")).toHaveLength(3);
  }));

  it("forces buyer-country reads, logs fallback only, and never calls supplier writes", async () => withDb(async (db, client) => {
    await applySourcing(client);
    const [shop] = await db.select().from(schema.shops).limit(1);
    const ctx = { db, now, shopId: shop.id, demo: true, log: vi.fn() };
    const supplier = supplierFixture();
    await fetchQuotes(db, "mug", "EU", { suppliers: [supplier], now, log: ctx.log });
    vi.mocked(supplier.quote).mockResolvedValue(quote({ providerRef: "1:2:3", inStock: false }));
    const alternative: Supplier = { ...supplierFixture(), id: "gelato", listProducts: vi.fn(async (): Promise<SupplierProduct[]> => [{
      supplier: "gelato", preset: "mug", uid: "g", title: "Mug", baseCostUsd: null,
      currency: null, sourceUrl: "https://product.gelatoapis.com/v3/catalogs", fetchedAt: now,
    }]), quote: vi.fn(async () => quote({ supplier: "gelato", providerRef: "g" })) };
    await fetchQuotes(db, "mug", "EU", { suppliers: [alternative], now, log: ctx.log });
    const decision = await recheckOrderSourcing(ctx, { preset: "mug", region: "EU", country: "FR", current }, [supplier, alternative]);
    expect(decision).toMatchObject({ switched: true, dryRun: true, choice: { supplier: "gelato" } });
    expect(supplier.quote).toHaveBeenLastCalledWith(expect.anything(), "FR");
    const destinationQuotes = await db.select().from(schema.supplierQuotes).where(eq(schema.supplierQuotes.destinationCountry, "FR"));
    expect(destinationQuotes).toHaveLength(2);
    expect(destinationQuotes.every((row) => row.region === "EU")).toBe(true);
    expect(supplier.createProduct).not.toHaveBeenCalled();
    expect(alternative.createProduct).not.toHaveBeenCalled();
    expect(alternative.listProducts).toHaveBeenCalledTimes(1);
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining("No supplier order was placed or moved"), "info");
    expect((await db.select().from(schema.sourcingChoices))).toHaveLength(0);
    const [listing] = await db.insert(schema.listings).values({
      niche: "alpine", productType: "pod", podProvider: "printify:mug", title: "Mug",
      tags: [], description: "", imageUrl: "", priceChf: 30, podCostChf: 10, netChf: 15, marginPct: 50,
    }).returning();
    await saveReceipts(db, [{
      receiptId: "dry-sourcing-test", etsyListingId: "123", totalChf: 30, quantity: 1, buyerCountry: "FR", createdAt: now,
    }], new Map([["123", listing]]), { offsite: () => false, isDemo: true, sourcingRecheck: async () => decision });
    const [order] = await db.select().from(schema.orders);
    expect(order.podOrderId).toBeNull();
    expect(order.podCostChf).toBeCloseTo(usdToChf(8), 2);
    const persisted = await db.execute(sql`select sourcing_recheck from orders where id = ${order.id}`);
    expect(persisted.rows[0].sourcing_recheck).toMatchObject({ dryRun: true, switched: true });
    await saveReceipts(db, [{
      receiptId: "live-sourcing-test", etsyListingId: "123", totalChf: 30, quantity: 1, buyerCountry: "FR", createdAt: now,
    }], new Map([["123", listing]]), { offsite: () => false, isDemo: false, sourcingRecheck: async () => decision });
    const [live] = await db.select().from(schema.orders).where(eq(schema.orders.etsyReceiptId, "live-sourcing-test"));
    expect(live.podCostChf).toBe(10);
    const log = vi.fn();
    await saveReceipts(db, [{
      receiptId: "dry-sourcing-failed", etsyListingId: "123", totalChf: 30, quantity: 1, buyerCountry: "FR", createdAt: now,
    }], new Map([["123", listing]]), {
      offsite: () => false, isDemo: true, log, sourcingRecheck: async () => { throw new Error("Quote failed"); },
    });
    const [failed] = await db.select().from(schema.orders).where(eq(schema.orders.etsyReceiptId, "dry-sourcing-failed"));
    expect(failed.podCostChf).toBe(10);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("saving the receipt"), "warn");
  }));

  it("matches a legacy blueprint/provider only when one variant qualifies", async () => withDb(async (db, client) => {
    await applySourcing(client);
    const [shop] = await db.select().from(schema.shops).limit(1);
    const supplier = supplierFixture();
    const ctx = { db, now, shopId: shop.id, demo: true, log: vi.fn() };
    await fetchQuotes(db, "mug", "CH", { suppliers: [supplier], now, log: ctx.log });
    const result = await recheckOrderSourcing(ctx, {
      preset: "mug", region: "CH", country: "CH", current: { ...current, providerRef: "1:2" },
    }, [supplier]);
    expect(result).toMatchObject({ switched: false, alert: false, choice: { providerRef: "1:2:3" } });
  }));
});
