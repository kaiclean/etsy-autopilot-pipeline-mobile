import { and, desc, eq, gte, inArray, isNotNull, notInArray } from "drizzle-orm";
import { getEtsyAdapter } from "@/adapters/etsy";
import type { EtsyReceipt } from "@/adapters/etsy/types";
import { getPrintifyAdapter, type PrintifyOrderStatus } from "@/adapters/printify";
import type { DB } from "@/db";
import { listings, orders, shops, type Listing } from "@/db/schema";
import { isDemoMode } from "@/lib/config";
import { quoteOrderEconomics } from "@/lib/economics";
import { emit, visible } from "@/lib/events";
import { calculateFees } from "@/lib/fees";
import { resolveUsdToChf } from "@/lib/fee-schedule";
import { normalizeLedgerEntry, summarizeLedger, type LedgerReceiptSummary } from "@/lib/ledger";
import { persistedOrderIsDemo, publishedListingsWhere, realOrderCursorWhere, receiptLookback, shouldSimulateReceipts } from "@/lib/real-orders";
import { getSetting } from "@/lib/settings";
import { syncAwaitingEtsyIds } from "./etsy-id-sync";
import type { StageFn } from "./types";

type ReceiptLog = (msg: string, level?: "info" | "warn" | "error") => void;

/** Persist every receipt. Unknown Etsy listing ids are stored unmatched instead of dropped. */
export async function saveReceipts(
  db: DB,
  receipts: EtsyReceipt[],
  byEtsyId: Map<string, Listing>,
  opts: {
    offsite: (receipt: EtsyReceipt) => boolean;
    podOrderId?: (listing: Listing, receipt: EtsyReceipt) => string | null;
    log?: ReceiptLog;
    shopId?: string;
    isDemo?: boolean;
  },
) {
  const log = opts.log ?? (() => {});
  const isDemo = opts.isDemo ?? isDemoMode();
  const existing = receipts.length
    ? new Set(
        (await db.select({ id: orders.etsyReceiptId }).from(orders).where(inArray(orders.etsyReceiptId, receipts.map((r) => r.receiptId)))).map(
          (r) => r.id,
        ),
      )
    : new Set<string>();

  let inserted = 0;
  let unmatched = 0;
  for (const r of receipts) {
    if (existing.has(r.receiptId)) continue;
    const l = byEtsyId.get(r.etsyListingId);
    if (!l) {
      const fees = calculateFees({ priceChf: r.totalChf / Math.max(r.quantity, 1), quantity: r.quantity, podCostChf: 0, offsiteAds: opts.offsite(r) });
      const insertedRows = await db
        .insert(orders)
        .values({
          ...(opts.shopId ? { shopId: opts.shopId } : {}),
          etsyReceiptId: r.receiptId,
          listingId: null,
          unmatchedEtsyListingId: r.etsyListingId,
          matchStatus: "unmatched",
          buyerCountry: r.buyerCountry,
          quantity: r.quantity,
          totalChf: fees.revenueChf,
          feesChf: fees.totalEtsyFeesChf,
          podCostChf: 0,
          offsiteAdsChf: fees.offsiteAdsFeeChf,
          refundedChf: 0,
          profitChf: 0,
          profitBasis: "estimated",
          fulfillmentStatus: "pending",
          isDemo,
          createdAt: r.createdAt,
        })
        .onConflictDoNothing({ target: orders.etsyReceiptId })
        .returning({ id: orders.id });
      if (insertedRows.length === 0) continue;
      existing.add(r.receiptId);
      inserted++;
      unmatched++;
      log(`Receipt ${r.receiptId} references listing ${r.etsyListingId} with no local row; saved as unmatched`, "warn");
      await emit(
        db,
        {
          type: "order.unmatched",
          title: `Unmatched order · CHF ${fees.revenueChf.toFixed(2)}`,
          body: `Etsy listing ${r.etsyListingId} is not in the pipeline yet. The receipt is kept until that id arrives.`,
          severity: "warning",
          href: "/orders",
          shopId: opts.shopId,
        },
        isDemo,
      );
      continue;
    }
    const offsite = opts.offsite(r);
    const fees = calculateFees({ priceChf: r.totalChf / r.quantity, quantity: r.quantity, podCostChf: l.podCostChf, offsiteAds: offsite });
    const insertedRows = await db
      .insert(orders)
      .values({
        ...(opts.shopId ? { shopId: opts.shopId } : {}),
        etsyReceiptId: r.receiptId,
        listingId: l.id,
        matchStatus: "matched",
        buyerCountry: r.buyerCountry,
        quantity: r.quantity,
        totalChf: fees.revenueChf,
        feesChf: fees.totalEtsyFeesChf,
        podCostChf: fees.podCostChf,
        offsiteAdsChf: fees.offsiteAdsFeeChf,
        refundedChf: r.refundChf ?? 0,
        profitChf: fees.netChf,
        profitBasis: "estimated",
        fulfillmentStatus: r.cancelled ? "cancelled" : l.productType === "digital" ? "delivered_digital" : "pending",
        podOrderId: opts.podOrderId?.(l, r) ?? null,
        isDemo,
        createdAt: r.createdAt,
      })
      .onConflictDoNothing({ target: orders.etsyReceiptId })
      .returning({ id: orders.id });
    if (insertedRows.length === 0) continue;
    existing.add(r.receiptId);
    inserted++;
    await emit(
      db,
      {
        type: "order.new",
        title: `New order · CHF ${fees.revenueChf.toFixed(2)}`,
        body: `${l.title.slice(0, 70)} → ${r.buyerCountry} · profit CHF ${fees.netChf.toFixed(2)}`,
        severity: "success",
        href: "/orders",
        shopId: opts.shopId ?? l.shopId,
      },
      isDemo,
    );
  }
  return { inserted, unmatched };
}

export const runOrders: StageFn = async (ctx) => {
  const { db, log } = ctx;
  const etsy = await getEtsyAdapter(db, ctx.random, "read");
  const printify = await getPrintifyAdapter({ db, random: ctx.random, intent: "read" });
  const idSync = await syncAwaitingEtsyIds(db, {
    now: ctx.now,
    shopId: ctx.shopId,
    lookup: (ids) => printify.getExternalEtsyIds(ids),
    log,
  });
  const [automation, feeFx] = await Promise.all([getSetting(db, "automation"), getSetting(db, "feeFx")]);
  const fx = resolveUsdToChf({ stored: feeFx?.usdToChf, storedAsOf: feeFx?.asOf });
  const published = await db
    .select({
      id: listings.id,
      shopId: listings.shopId,
      etsyListingId: listings.etsyListingId,
      priceChf: listings.priceChf,
      productType: listings.productType,
      podCostChf: listings.podCostChf,
      title: listings.title,
    })
    .from(listings)
    .where(publishedListingsWhere(ctx.shopId));
  const byEtsyId = new Map(published.map((l) => [l.etsyListingId!, l as Listing]));

  const [shop] = await db
    .select({ createdAt: shops.createdAt, etsyShopId: shops.etsyShopId })
    .from(shops)
    .where(eq(shops.id, ctx.shopId));
  const [lastReal] = await db
    .select({ createdAt: orders.createdAt })
    .from(orders)
    .where(realOrderCursorWhere(ctx.shopId))
    .orderBy(desc(orders.createdAt))
    .limit(1);
  const cursor = lastReal?.createdAt ?? receiptLookback(ctx.now, shop?.createdAt ?? null);
  const refresh = new Date(ctx.now.getTime() - 30 * 864e5);
  const since = cursor.getTime() < refresh.getTime() ? cursor : refresh;
  const receipts = await etsy.getReceipts({
    since,
    candidates: published.map((l) => ({ etsyListingId: l.etsyListingId!, priceChf: l.priceChf, productType: l.productType })),
    simulateAtLeastOne: shouldSimulateReceipts(etsy.mode, ctx.trigger),
  });
  log(`Etsy (${etsy.mode}) returned ${receipts.length} receipt line(s) since ${since.toISOString()}`);

  let ledgerByReceipt = new Map<string, LedgerReceiptSummary>();
  if (etsy.mode === "live") {
    try {
      const raw = await etsy.getLedgerEntries({ since, until: ctx.now });
      const normalized = raw.flatMap((entry) => {
        const row = normalizeLedgerEntry(entry, fx.rate);
        return row ? [row] : [];
      });
      ledgerByReceipt = summarizeLedger(normalized).byReceipt;
      log(`Etsy ledger: ${normalized.length} entr${normalized.length === 1 ? "y" : "ies"}, ${ledgerByReceipt.size} receipt(s)`);
    } catch (error) {
      log(`Etsy ledger unavailable, profit stays estimated: ${(error as Error).message}`, "warn");
    }
  }

  const persistDemo = persistedOrderIsDemo(isDemoMode(shop?.etsyShopId), etsy.mode);
  const { inserted, unmatched } = await saveReceipts(db, receipts, byEtsyId, {
    shopId: ctx.shopId,
    isDemo: persistDemo,
    offsite: () => (etsy.mode === "dry-run" ? ctx.random() < 0.12 : automation.assumeOffsiteAds),
    podOrderId: (listing, receipt) => (listing.productType === "pod" && etsy.mode === "dry-run" ? `dry-po-${receipt.receiptId}` : null),
    log,
  });

  const existingRows = receipts.length
    ? await db
        .select()
        .from(orders)
        .where(inArray(orders.etsyReceiptId, receipts.map((r) => r.receiptId)))
    : [];
  const existing = new Map(existingRows.map((row) => [row.etsyReceiptId, row]));
  const podIds = [
    ...new Set(
      (
        await db
          .select({ podOrderId: orders.podOrderId })
          .from(orders)
          .where(and(eq(orders.shopId, ctx.shopId), isNotNull(orders.podOrderId), eq(orders.profitBasis, "estimated"), gte(orders.createdAt, since)))
      )
        .map((row) => row.podOrderId)
        .filter((id): id is string => typeof id === "string" && !id.startsWith("dry-") && !id.startsWith("demo-")),
    ),
  ];
  const podCosts = podIds.length ? await printify.getOrderCosts(podIds) : {};

  let updated = 0;
  for (const r of receipts) {
    const l = byEtsyId.get(r.etsyListingId);
    const prior = existing.get(r.receiptId);
    if (!l || !prior || prior.matchStatus === "unmatched") continue;
    const podOrderId = prior.podOrderId;
    const actual = podOrderId ? podCosts[podOrderId] : undefined;
    const podCostChf = actual?.costChf ?? l.podCostChf;
    if (actual?.assumedChf) log(`Printify order ${podOrderId} has no currency; supplier cost is assumed CHF`);
    const economics = quoteOrderEconomics({
      mode: etsy.mode,
      assumeOffsiteAds: automation.assumeOffsiteAds,
      dryRunOffsite: prior.offsiteAdsChf > 0,
      quantity: r.quantity,
      itemChf: r.totalChf,
      shippingChf: r.shippingChf,
      discountChf: r.discountChf,
      taxChf: r.taxChf,
      refundChf: r.refundChf,
      cancelled: r.cancelled,
      podCostChf,
      podCostFromOrder: Boolean(actual),
      ledger: ledgerByReceipt.get(r.etsyReceiptId ?? r.receiptId) ?? null,
      buyerCountry: r.buyerCountry,
      usdToChf: fx.rate,
    });
    const changed =
      prior.profitChf !== economics.profitChf ||
      prior.profitBasis !== economics.basis ||
      prior.refundedChf !== economics.refundedChf ||
      prior.offsiteAdsChf !== economics.offsiteAdsChf ||
      prior.podCostChf !== economics.podCostChf;
    if (!changed) continue;
    await db
      .update(orders)
      .set({
        totalChf: economics.totalChf,
        feesChf: economics.feesChf,
        podCostChf: economics.podCostChf,
        offsiteAdsChf: economics.offsiteAdsChf,
        refundedChf: economics.refundedChf,
        profitChf: economics.profitChf,
        profitBasis: economics.basis,
        fulfillmentStatus: economics.cancelled ? "cancelled" : prior.fulfillmentStatus,
        updatedAt: ctx.now,
      })
      .where(eq(orders.id, prior.id));
    updated++;
  }

  const open = await db
    .select({ id: orders.id, podOrderId: orders.podOrderId, status: orders.fulfillmentStatus })
    .from(orders)
    .where(
      and(
        eq(orders.shopId, ctx.shopId),
        isNotNull(orders.podOrderId),
        notInArray(orders.fulfillmentStatus, ["delivered", "delivered_digital", "cancelled"]),
        visible(orders.isDemo),
      ),
    );
  let advanced = 0;
  if (open.length) {
    const known = Object.fromEntries(open.map((o) => [o.podOrderId!, o.status as PrintifyOrderStatus]));
    const statusAdapter = await getPrintifyAdapter({ db, random: ctx.random, known, intent: "read" });
    const statuses = await statusAdapter.getOrderStatuses(open.map((o) => o.podOrderId!));
    for (const o of open) {
      const next = statuses[o.podOrderId!];
      if (next && next !== o.status) {
        await db.update(orders).set({ fulfillmentStatus: next, updatedAt: ctx.now }).where(eq(orders.id, o.id));
        advanced++;
      }
    }
    log(`POD fulfillment: ${advanced}/${open.length} open orders changed status`);
  }
  return `${inserted} new order(s), ${unmatched} unmatched, ${updated} profit update(s), ${idSync.linked} Etsy id(s) linked, ${advanced} fulfillment update(s)`;
};
