import { and, eq, gte, isNotNull, like, notLike, or, type SQL } from "drizzle-orm";
import { listings, orders } from "@/db/schema";
import { isDemoMode } from "@/lib/config";
import { visible } from "@/lib/events";

/** Days of history to re-read when a shop has no real receipt stored yet. */
export const RECEIPT_LOOKBACK_DAYS = 60;

const DAY_MS = 864e5;

function defined(sql: SQL | undefined): SQL {
  if (!sql) throw new Error("Expected a SQL filter");
  return sql;
}

/** Receipt ids invented by the seed or the dry-run adapter. */
export function fakeReceiptWhere(): SQL {
  return defined(or(like(orders.etsyReceiptId, "demo-%"), like(orders.etsyReceiptId, "dry-%")));
}

export function notFakeReceiptWhere(): SQL {
  return defined(and(notLike(orders.etsyReceiptId, "demo-%"), notLike(orders.etsyReceiptId, "dry-%")));
}

/**
 * Orders that may count as sales outside demo mode.
 * `visible()` hides `is_demo` rows. The prefix filter also drops dry-run and seed
 * receipts that were stored with `is_demo=false`.
 */
export function dashboardOrdersWhere(): SQL | undefined {
  return and(visible(orders.isDemo), isDemoMode() ? undefined : notFakeReceiptWhere());
}

/** Cron / stage totals. Fake receipt ids never count, including while demo mode is on. */
export function analyticsOrdersWhere(shopId: string, since: Date): SQL {
  return defined(and(eq(orders.shopId, shopId), gte(orders.createdAt, since), visible(orders.isDemo), notFakeReceiptWhere()));
}

/** Newest row that can advance the Etsy receipt cursor for this shop. */
export function realOrderCursorWhere(shopId: string): SQL {
  return defined(and(eq(orders.shopId, shopId), eq(orders.isDemo, false), notFakeReceiptWhere()));
}

/** Published listings this shop may ask Etsy about. Demo rows stay out of live reads. */
export function publishedListingsWhere(shopId: string): SQL {
  return defined(
    and(eq(listings.shopId, shopId), eq(listings.status, "published"), isNotNull(listings.etsyListingId), visible(listings.isDemo)),
  );
}

/**
 * Fetch start when no real receipt exists.
 * The earlier of the shop row's `created_at` and a 60-day window is used so a
 * registry row stamped at migration time cannot skip sales from the shop's open
 * date, and a shop older than 60 days is not clipped to that window.
 */
export function receiptLookback(now: Date, shopCreatedAt: Date | null | undefined): Date {
  const windowStart = new Date(now.getTime() - RECEIPT_LOOKBACK_DAYS * DAY_MS);
  if (!shopCreatedAt) return windowStart;
  return shopCreatedAt.getTime() < windowStart.getTime() ? new Date(shopCreatedAt.getTime()) : windowStart;
}

/** Dry-run simulations are demo data even when the process is not in demo mode. */
export function persistedOrderIsDemo(demoMode: boolean, adapterMode: "dry-run" | "live"): boolean {
  return demoMode || adapterMode === "dry-run";
}

/** Live reads must never invent receipts. Dry-run cron stays probabilistic. */
export function shouldSimulateReceipts(adapterMode: "dry-run" | "live", trigger: "manual" | "cron" | "chain"): boolean {
  return adapterMode === "dry-run" && trigger !== "cron";
}

/** Rows the cleanup script removes: flagged demo, or a seed / dry-run receipt id. */
export function removableOrderWhere(): SQL {
  return defined(or(eq(orders.isDemo, true), fakeReceiptWhere()));
}
