import { and, desc, eq, inArray, isNotNull, notInArray } from "drizzle-orm";
import { getEtsyAdapter } from "@/adapters/etsy";
import { getPrintifyAdapter, type PrintifyOrderStatus } from "@/adapters/printify";
import { listings, orders } from "@/db/schema";
import { isDemoMode } from "@/lib/config";
import { emit } from "@/lib/events";
import { calculateFees } from "@/lib/fees";
import type { StageFn } from "./types";

export const runOrders: StageFn = async (ctx) => {
  const { db, log } = ctx;
  const etsy = await getEtsyAdapter(db, ctx.random, "read");
  const published = await db
    .select()
    .from(listings)
    .where(and(eq(listings.status, "published"), isNotNull(listings.etsyListingId)));
  const byEtsyId = new Map(published.map((l) => [l.etsyListingId!, l]));

  const [last] = await db.select({ createdAt: orders.createdAt }).from(orders).orderBy(desc(orders.createdAt)).limit(1);
  const since = last?.createdAt ?? new Date(ctx.now.getTime() - 30 * 864e5);
  const receipts = await etsy.getReceipts({
    since,
    candidates: published.map((l) => ({ etsyListingId: l.etsyListingId!, priceChf: l.priceChf, productType: l.productType })),
    simulateAtLeastOne: ctx.trigger !== "cron",
  });
  log(`Etsy (${etsy.mode}) returned ${receipts.length} receipt line(s) since ${since.toISOString()}`);

  const existing = receipts.length
    ? new Set(
        (await db.select({ id: orders.etsyReceiptId }).from(orders).where(inArray(orders.etsyReceiptId, receipts.map((r) => r.receiptId)))).map(
          (r) => r.id,
        ),
      )
    : new Set<string>();

  let inserted = 0;
  for (const r of receipts) {
    if (existing.has(r.receiptId)) continue;
    const l = byEtsyId.get(r.etsyListingId);
    if (!l) {
      log(`Receipt ${r.receiptId} references unknown listing ${r.etsyListingId}; skipped`, "warn");
      continue;
    }
    const offsite = etsy.mode === "dry-run" ? ctx.random() < 0.12 : false;
    const fees = calculateFees({ priceChf: r.totalChf / r.quantity, quantity: r.quantity, podCostChf: l.podCostChf, offsiteAds: offsite });
    await db.insert(orders).values({
      shopId: ctx.shopId,
      etsyReceiptId: r.receiptId,
      listingId: l.id,
      buyerCountry: r.buyerCountry,
      quantity: r.quantity,
      totalChf: fees.revenueChf,
      feesChf: fees.totalEtsyFeesChf,
      podCostChf: fees.podCostChf,
      offsiteAdsChf: fees.offsiteAdsFeeChf,
      profitChf: fees.netChf,
      fulfillmentStatus: l.productType === "digital" ? "delivered_digital" : "pending",
      podOrderId: l.productType === "pod" && etsy.mode === "dry-run" ? `dry-po-${r.receiptId}` : null,
      isDemo: isDemoMode(),
      createdAt: r.createdAt,
    });
    inserted++;
    await emit(db, {
      type: "order.new",
      title: `New order · CHF ${fees.revenueChf.toFixed(2)}`,
      body: `${l.title.slice(0, 70)} → ${r.buyerCountry} · profit CHF ${fees.netChf.toFixed(2)}`,
      severity: "success",
      href: "/orders",
    });
  }

  const open = await db
    .select({ id: orders.id, podOrderId: orders.podOrderId, status: orders.fulfillmentStatus })
    .from(orders)
    .where(and(isNotNull(orders.podOrderId), notInArray(orders.fulfillmentStatus, ["delivered", "delivered_digital"])));
  let advanced = 0;
  if (open.length) {
    const known = Object.fromEntries(open.map((o) => [o.podOrderId!, o.status as PrintifyOrderStatus]));
    const printify = await getPrintifyAdapter({ db, random: ctx.random, known, intent: "read" });
    const statuses = await printify.getOrderStatuses(open.map((o) => o.podOrderId!));
    for (const o of open) {
      const next = statuses[o.podOrderId!];
      if (next && next !== o.status) {
        await db.update(orders).set({ fulfillmentStatus: next, updatedAt: ctx.now }).where(eq(orders.id, o.id));
        advanced++;
      }
    }
    log(`POD fulfillment: ${advanced}/${open.length} open orders changed status`);
  }
  return `${inserted} new order(s), ${advanced} fulfillment update(s)`;
};
