import { and, desc, eq, inArray, isNotNull, notInArray } from "drizzle-orm";
import { getEtsyAdapter } from "@/adapters/etsy";
import type { EtsyReceipt } from "@/adapters/etsy/types";
import { getPrintifyAdapter, type PrintifyOrderStatus } from "@/adapters/printify";
import type { DB } from "@/db";
import { listings, orders, shops, type Listing } from "@/db/schema";
import { isDemoMode } from "@/lib/config";
import { emit, visible } from "@/lib/events";
import { calculateFees } from "@/lib/fees";
import { persistedOrderIsDemo, publishedListingsWhere, realOrderCursorWhere, receiptLookback, shouldSimulateReceipts } from "@/lib/real-orders";
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
          profitChf: 0,
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
        profitChf: fees.netChf,
        fulfillmentStatus: l.productType === "digital" ? "delivered_digital" : "pending",
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
  const since = lastReal?.createdAt ?? receiptLookback(ctx.now, shop?.createdAt ?? null);
  const receipts = await etsy.getReceipts({
    since,
    candidates: published.map((l) => ({ etsyListingId: l.etsyListingId!, priceChf: l.priceChf, productType: l.productType })),
    simulateAtLeastOne: shouldSimulateReceipts(etsy.mode, ctx.trigger),
  });
  log(`Etsy (${etsy.mode}) returned ${receipts.length} receipt line(s) since ${since.toISOString()}`);

  const persistDemo = persistedOrderIsDemo(isDemoMode(shop?.etsyShopId), etsy.mode);
  const { inserted, unmatched } = await saveReceipts(db, receipts, byEtsyId, {
    shopId: ctx.shopId,
    isDemo: persistDemo,
    offsite: () => (etsy.mode === "dry-run" ? ctx.random() < 0.12 : false),
    podOrderId: (listing, receipt) => (listing.productType === "pod" && etsy.mode === "dry-run" ? `dry-po-${receipt.receiptId}` : null),
    log,
  });

  const open = await db
    .select({ id: orders.id, podOrderId: orders.podOrderId, status: orders.fulfillmentStatus })
    .from(orders)
    .where(
      and(
        eq(orders.shopId, ctx.shopId),
        isNotNull(orders.podOrderId),
        notInArray(orders.fulfillmentStatus, ["delivered", "delivered_digital"]),
        visible(orders.isDemo),
      ),
    );
  let advanced = 0;
  if (open.length) {
    const known = Object.fromEntries(open.map((o) => [o.podOrderId!, o.status as PrintifyOrderStatus]));
    const fulfillment = await getPrintifyAdapter({ db, random: ctx.random, known, intent: "read" });
    const statuses = await fulfillment.getOrderStatuses(open.map((o) => o.podOrderId!));
    for (const o of open) {
      const next = statuses[o.podOrderId!];
      if (next && next !== o.status) {
        await db.update(orders).set({ fulfillmentStatus: next, updatedAt: ctx.now }).where(eq(orders.id, o.id));
        advanced++;
      }
    }
    log(`POD fulfillment: ${advanced}/${open.length} open orders changed status`);
  }
  return `${inserted} new order(s), ${unmatched} unmatched, ${idSync.linked} Etsy id(s) linked, ${advanced} fulfillment update(s)`;
};
