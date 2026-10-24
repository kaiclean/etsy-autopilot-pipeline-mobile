import { advanceOrder } from "@/lib/fulfillment-state";
import { and, eq, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
import { getEtsyAdapter } from "@/adapters/etsy";
import type { EtsyReceipt } from "@/adapters/etsy/types";
import { getPrintifyAdapter, type PrintifyOrderStatus } from "@/adapters/printify";
import type { DB } from "@/db";
import { listings, orders, shops, type Listing } from "@/db/schema";
import { etsySyncState } from "@/db/etsy-sync";
import { isDemoMode } from "@/lib/config";
import { emit, visible } from "@/lib/events";
import { dispatchEventPush } from "@/lib/push";
import { claimSaleAlert, isRealSaleReceipt } from "@/lib/sale-alert";
import { calculateFees } from "@/lib/fees";
import { persistedOrderIsDemo, publishedListingsWhere, receiptLookback, shouldSimulateReceipts } from "@/lib/real-orders";
import { syncAwaitingEtsyIds } from "./etsy-id-sync";
import { flagStalledFulfillment } from "./fulfillment-watch";
import type { StageFn } from "./types";
import { listingPreset, recheckOrderSourcing, sourcingAvailable } from "./sourcing";
import { buyerRegion } from "@/lib/sourcing";
import { resolveActiveShop } from "@/lib/shops";

type ReceiptLog = (msg: string, level?: "info" | "warn" | "error") => void;

async function saveLiveReceipt(
  db: DB,
  receipt: EtsyReceipt,
  shopId: string,
  order?: typeof orders.$inferInsert,
  recheck?: Awaited<ReturnType<typeof recheckOrderSourcing>> | null,
) {
  const statement = sql`
    with accepted_observation as (
      insert into etsy_receipt_snapshots (
        shop_id, receipt_line_id, etsy_listing_id, paid, canceled, refund_detected,
        quantity, original_money, fx_rate, fx_as_of, source_modified_at, observed_at
      ) values (
        ${shopId}::uuid, ${receipt.receiptId}, ${receipt.etsyListingId}, ${receipt.paid !== false},
        ${receipt.canceled === true}, ${receipt.refunded === true}, ${receipt.quantity},
        ${receipt.originalMoney ? JSON.stringify(receipt.originalMoney) : null}::jsonb, ${receipt.fxRate ?? null},
        ${receipt.fxAsOf ? new Date(receipt.fxAsOf).toISOString() : null}::timestamptz,
        ${(receipt.modifiedAt ?? receipt.createdAt).toISOString()}::timestamptz, now()
      )
      on conflict (shop_id, receipt_line_id) do update set
        etsy_listing_id = excluded.etsy_listing_id, paid = excluded.paid,
        canceled = case when etsy_receipt_snapshots.source_modified_at = excluded.source_modified_at
          then etsy_receipt_snapshots.canceled or excluded.canceled else excluded.canceled end,
        refund_detected = case when etsy_receipt_snapshots.source_modified_at = excluded.source_modified_at
          then etsy_receipt_snapshots.refund_detected or excluded.refund_detected else excluded.refund_detected end,
        quantity = excluded.quantity, original_money = excluded.original_money,
        fx_rate = excluded.fx_rate, fx_as_of = excluded.fx_as_of,
        source_modified_at = excluded.source_modified_at, observed_at = excluded.observed_at
      where etsy_receipt_snapshots.source_modified_at <= excluded.source_modified_at
      returning *
    ), updated_order as (
      update orders set etsy_payment_status = case
        when observation.canceled then 'canceled'
        when observation.refund_detected then 'refund_pending'
        when observation.paid then 'paid'
        when orders.etsy_payment_status in ('canceled', 'refund_pending') then orders.etsy_payment_status
        else 'unpaid' end,
        updated_at = now()
      from accepted_observation observation
      where orders.shop_id = observation.shop_id and orders.etsy_receipt_id = observation.receipt_line_id
      returning orders.id
    ), inserted_order as (
      ${order ? sql`
        insert into orders (
          shop_id, etsy_receipt_id, listing_id, unmatched_etsy_listing_id, match_status,
          buyer_country, quantity, total_chf, fees_chf, pod_cost_chf, offsite_ads_chf,
          profit_chf, fulfillment_status, fulfillment_changed_at, pod_order_id, is_demo,
          created_at${recheck ? sql`, sourcing_recheck` : sql``}
        )
        select observation.shop_id, observation.receipt_line_id, ${order.listingId ?? null},
          ${order.unmatchedEtsyListingId ?? null}, ${order.matchStatus ?? "matched"},
          ${order.buyerCountry}, ${order.quantity ?? 1}, ${order.totalChf}, ${order.feesChf},
          ${order.podCostChf ?? 0}, ${order.offsiteAdsChf ?? 0}, ${order.profitChf},
          ${order.fulfillmentStatus}, ${receipt.createdAt.toISOString()}::timestamptz,
          ${order.podOrderId ?? null}, false, ${receipt.createdAt.toISOString()}::timestamptz
          ${recheck ? sql`, ${JSON.stringify(recheck)}::jsonb` : sql``}
        from accepted_observation observation
        where observation.paid and not observation.canceled and not observation.refund_detected
          and not exists (select 1 from updated_order)
        on conflict (etsy_receipt_id) do nothing
        returning id
      ` : sql`select null::integer as id where false`}
    )
    select (select id from inserted_order) as id,
      exists (select 1 from accepted_observation) as accepted,
      exists (select 1 from updated_order) as updated
  `;
  const result = await db.execute<{ id: number | null; accepted: boolean; updated: boolean }>(statement);
  let row = result.rows[0];
  // A lock wait can hide a concurrent first order insert from this statement's MVCC snapshot.
  // Replay once with a fresh snapshot; acceptance still guards against newer observations.
  if (row.accepted && row.id === null && !row.updated) {
    row = (await db.execute<{ id: number | null; accepted: boolean; updated: boolean }>(statement)).rows[0];
  }
  return row.id === null ? [] : [{ id: row.id }];
}

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
    sourcingRecheck?: (listing: Listing, receipt: EtsyReceipt) => Promise<Awaited<ReturnType<typeof recheckOrderSourcing>> | null>;
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
  const sourceShopId = opts.shopId ?? (receipts.length ? (await resolveActiveShop(db)).id : undefined);
  for (const r of receipts) {
    const l = byEtsyId.get(r.etsyListingId);
    if (l && sourceShopId && l.shopId !== sourceShopId) throw new Error("Receipt listing does not belong to this shop");
    if (existing.has(r.receiptId) || r.paid === false || r.canceled || r.refunded) {
      if (!isDemo && sourceShopId) await saveLiveReceipt(db, r, sourceShopId);
      continue;
    }
    if (!l) {
      const fees = calculateFees({ priceChf: r.totalChf / Math.max(r.quantity, 1), quantity: r.quantity, podCostChf: 0, offsiteAds: opts.offsite(r) });
      const values: typeof orders.$inferInsert = {
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
          fulfillmentChangedAt: r.createdAt,
          isDemo,
          createdAt: r.createdAt,
        };
      const insertedRows = !isDemo && sourceShopId
        ? await saveLiveReceipt(db, r, sourceShopId, values)
        : await db.insert(orders).values(values).onConflictDoNothing({ target: orders.etsyReceiptId }).returning({ id: orders.id });
    if (insertedRows.length === 0) continue;
    existing.add(r.receiptId);
    inserted++;
    unmatched++;
    log(`Receipt ${r.receiptId} references listing ${r.etsyListingId} with no local row; saved as unmatched`, "warn");
    const pushUnmatched = isRealSaleReceipt(r.receiptId, isDemo) && (await claimSaleAlert(db, r.receiptId, opts.shopId));
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
        { push: false },
      );
    if (pushUnmatched) {
      await dispatchEventPush(db, {
        type: "order.new",
        title: `New order · CHF ${fees.revenueChf.toFixed(2)}`,
        body: `Etsy listing ${r.etsyListingId} is not in the pipeline yet.`,
        href: "/orders",
      });
    }
      continue;
    }
    const offsite = opts.offsite(r);
    let recheck: Awaited<ReturnType<typeof recheckOrderSourcing>> | null | undefined;
    if (opts.sourcingRecheck) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        recheck = await Promise.race([
          opts.sourcingRecheck(l, r),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error("Sourcing recheck timed out")), 60_000);
          }),
        ]);
      } catch {
        log(`Receipt ${r.receiptId}: sourcing unavailable; preserving listing cost and saving the receipt. No supplier order was placed or moved.`, "warn");
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
    // Fallbacks are recommendations only. A live receipt's actual fulfillment cost is not rewritten to a simulated alternative.
    const sourcedCost = recheck && !recheck.alert && (!recheck.switched || isDemo) ? recheck.choice?.landedCostChf : null;
    const fees = calculateFees({ priceChf: r.totalChf / r.quantity, quantity: r.quantity, podCostChf: sourcedCost ?? l.podCostChf, offsiteAds: offsite });
    const values: typeof orders.$inferInsert = {
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
        fulfillmentChangedAt: r.createdAt,
        podOrderId: opts.podOrderId?.(l, r) ?? null,
        isDemo,
        createdAt: r.createdAt,
      };
    const insertedRows = !isDemo && sourceShopId
      ? await saveLiveReceipt(db, r, sourceShopId, values, recheck)
      : await db.insert(orders).values(values).onConflictDoNothing({ target: orders.etsyReceiptId }).returning({ id: orders.id });
    if (insertedRows.length === 0) continue;
    if (recheck && isDemo) {
      await db.execute(sql`update orders set sourcing_recheck = ${JSON.stringify(recheck)}::jsonb where id = ${insertedRows[0].id}`);
    }
    existing.add(r.receiptId);
    inserted++;
    const pushSale = isRealSaleReceipt(r.receiptId, isDemo) && (await claimSaleAlert(db, r.receiptId, opts.shopId ?? l.shopId));
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
      { push: pushSale },
    );
  }
  return { inserted, unmatched };
}

export const runOrders: StageFn = async (ctx) => {
  const { db, log } = ctx;
  const etsy = await getEtsyAdapter(db, ctx.random, "read", ctx.shopId);
  const printify = await getPrintifyAdapter({ db, random: ctx.random, intent: "read", shopId:ctx.shopId });
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
      podProvider: listings.podProvider,
      supplier: listings.supplier,
      supplierProductId: listings.supplierProductId,
      podBlueprintId: listings.podBlueprintId,
      podPrintProviderId: listings.podPrintProviderId,
      title: listings.title,
    })
    .from(listings)
    .where(publishedListingsWhere(ctx.shopId));
  const byEtsyId = new Map(published.map((l) => [l.etsyListingId!, l as Listing]));

  const [shop] = await db
    .select({ createdAt: shops.createdAt, etsyShopId: shops.etsyShopId })
    .from(shops)
    .where(eq(shops.id, ctx.shopId));
  const [sync] = await db.select().from(etsySyncState).where(eq(etsySyncState.shopId, ctx.shopId));
  // Updated-time watermarks find late payments and changes to old receipts. Overlap tolerates eventual consistency.
  const previous = sync?.receiptsThrough;
  const since = previous ? new Date(previous.getTime() - 5 * 60_000) : receiptLookback(ctx.now, shop?.createdAt ?? null);
  const receipts = await etsy.getReceipts({
    since,
    candidates: published.map((l) => ({ etsyListingId: l.etsyListingId!, priceChf: l.priceChf, productType: l.productType })),
    simulateAtLeastOne: shouldSimulateReceipts(etsy.mode, ctx.trigger),
  });
  log(`Etsy (${etsy.mode}) returned ${receipts.length} receipt line(s) since ${since.toISOString()}`);

  const persistDemo = persistedOrderIsDemo(isDemoMode(shop?.etsyShopId), etsy.mode);
  const canRecheck = await sourcingAvailable(db);
  const sourcingRecheck: Parameters<typeof saveReceipts>[3]["sourcingRecheck"] = async (listing, receipt) => {
    const preset = listingPreset(listing.podProvider);
    const region = buyerRegion(receipt.buyerCountry);
    if (!canRecheck || listing.productType !== "pod" || !preset || !region) return null;
    const providerRef = listing.supplierProductId ??
      (listing.podBlueprintId && listing.podPrintProviderId ? `${listing.podBlueprintId}:${listing.podPrintProviderId}` : null);
    return recheckOrderSourcing(ctx, {
      preset, region, country: receipt.buyerCountry.toUpperCase(),
      current: { supplier: listing.supplier ?? "printify", providerRef, landedCostChf: listing.podCostChf },
    });
  };
  const { inserted, unmatched } = await saveReceipts(db, receipts, byEtsyId, {
    shopId: ctx.shopId,
    isDemo: persistDemo,
    offsite: () => (etsy.mode === "dry-run" ? ctx.random() < 0.12 : false),
    podOrderId: (listing, receipt) => (listing.productType === "pod" && etsy.mode === "dry-run" ? `dry-po-${receipt.receiptId}` : null),
    log,
    sourcingRecheck,
  });
  if (etsy.mode === "live") {
    await db.insert(etsySyncState).values({ shopId: ctx.shopId, receiptsThrough: ctx.now })
      .onConflictDoUpdate({
        target: etsySyncState.shopId,
        set: { receiptsThrough: ctx.now },
        setWhere: sql`${etsySyncState.receiptsThrough} IS NULL OR ${etsySyncState.receiptsThrough} < ${ctx.now}`,
      });
  }

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
    const fulfillment = await getPrintifyAdapter({ db, random: ctx.random, known, intent: "read", shopId:ctx.shopId });
    const statuses = await fulfillment.getOrderStatuses(open.map((o) => o.podOrderId!));
    for (const o of open) {
      const next = statuses[o.podOrderId!];
      if (next && next !== o.status) {
        if(await advanceOrder(db,o.id,next)) advanced++;
      }
    }
    log(`POD fulfillment: ${advanced}/${open.length} open orders changed status`);
  }
  const stalled = await flagStalledFulfillment(db, { shopId: ctx.shopId, now: ctx.now });
  if (stalled.flagged) log(`Flagged ${stalled.flagged} Printify order(s) with no status progress for 48 hours`, "warn");
  return `${inserted} new order(s), ${unmatched} unmatched, ${idSync.linked} Etsy id(s) linked, ${advanced} fulfillment update(s), ${stalled.flagged} stalled`;
};
