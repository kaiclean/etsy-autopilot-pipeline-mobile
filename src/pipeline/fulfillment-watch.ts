import { and, eq, isNotNull, isNull, notInArray, notLike, sql } from "drizzle-orm";
import type { DB } from "@/db";
import { orders, type FulfillmentStatus } from "@/db/schema";
import { emit } from "@/lib/events";

export const FULFILLMENT_STALL_MS = 48 * 60 * 60 * 1000;

const OPEN: FulfillmentStatus[] = ["pending", "in_production", "shipped"];

export function fulfillmentIsStalled(input: {
  podOrderId: string | null;
  fulfillmentStatus: FulfillmentStatus;
  changedAt: Date | null;
  createdAt: Date;
  isDemo: boolean;
  etsyReceiptId: string;
  now: Date;
}) {
  if (input.isDemo) return false;
  if (!input.podOrderId || input.podOrderId.startsWith("dry-")) return false;
  if (input.etsyReceiptId.startsWith("demo-") || input.etsyReceiptId.startsWith("dry-")) return false;
  if (!OPEN.includes(input.fulfillmentStatus)) return false;
  const changed = input.changedAt ?? input.createdAt;
  return input.now.getTime() - changed.getTime() > FULFILLMENT_STALL_MS;
}

/**
 * Flags Printify orders with no status progress for more than 48 hours.
 * Each order is alerted once until the status actually changes.
 */
export async function flagStalledFulfillment(db: DB, opts: { shopId: string; now: Date }) {
  const cutoff = new Date(opts.now.getTime() - FULFILLMENT_STALL_MS);
  const rows = await db
    .select({
      id: orders.id,
      podOrderId: orders.podOrderId,
      fulfillmentStatus: orders.fulfillmentStatus,
      etsyReceiptId: orders.etsyReceiptId,
    })
    .from(orders)
    .where(
      and(
        eq(orders.shopId, opts.shopId),
        eq(orders.isDemo, false),
        isNotNull(orders.podOrderId),
        notLike(orders.podOrderId, "dry-%"),
        notLike(orders.etsyReceiptId, "demo-%"),
        notLike(orders.etsyReceiptId, "dry-%"),
        notInArray(orders.fulfillmentStatus, ["delivered", "delivered_digital"]),
        isNull(orders.fulfillmentStalledAt),
        sql`coalesce(${orders.fulfillmentChangedAt}, ${orders.createdAt}) < ${cutoff}`,
      ),
    );

  let flagged = 0;
  for (const row of rows) {
    const claimed = await db
      .update(orders)
      .set({ fulfillmentStalledAt: opts.now, updatedAt: opts.now })
      .where(and(eq(orders.id, row.id), isNull(orders.fulfillmentStalledAt)))
      .returning({ id: orders.id });
    if (claimed.length === 0) continue;
    flagged++;
    await emit(
      db,
      {
        type: "fulfillment.stalled",
        title: `Printify order stalled · ${row.podOrderId}`,
        body: `No status progress for 48 hours. Still ${row.fulfillmentStatus.replaceAll("_", " ")}. Receipt ${row.etsyReceiptId}.`,
        severity: "warning",
        href: "/orders",
        shopId: opts.shopId,
      },
      false,
    );
  }
  return { flagged };
}
