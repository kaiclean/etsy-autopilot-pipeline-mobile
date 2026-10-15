import { boolean, doublePrecision, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { shops } from "./schema";
import type { EtsyMoney } from "@/adapters/etsy/money";

/** Receipt cursors advance only after the complete paginated batch is persisted. */
export const etsySyncState = pgTable("etsy_sync_state", {
  shopId: uuid("shop_id").primaryKey().references(() => shops.id),
  receiptsThrough: timestamp("receipts_through", { withTimezone: true }),
  refreshLeaseOwner: uuid("refresh_lease_owner"),
  refreshLeaseUntil: timestamp("refresh_lease_until", { withTimezone: true }),
});

/** Redacted receipt-line observations. Financial estimates remain on orders, not here. */
export const etsyReceiptSnapshots = pgTable("etsy_receipt_snapshots", {
  shopId: uuid("shop_id").notNull().references(() => shops.id),
  receiptLineId: text("receipt_line_id").notNull(),
  etsyListingId: text("etsy_listing_id").notNull(),
  paid: boolean("paid").notNull(),
  canceled: boolean("canceled").notNull(),
  refundDetected: boolean("refund_detected").notNull(),
  quantity: integer("quantity").notNull(),
  originalMoney: jsonb("original_money").$type<EtsyMoney>(),
  fxRate: doublePrecision("fx_rate"),
  fxAsOf: timestamp("fx_as_of", { withTimezone: true }),
  sourceModifiedAt: timestamp("source_modified_at", { withTimezone: true }).notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.shopId, t.receiptLineId] })]);
