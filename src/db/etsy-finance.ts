import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, serial, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { listings, shops } from "./schema";

export type FinancialEvidenceStatus = "actual" | "estimated" | "unavailable";
export type FinancialComponent = "revenue" | "fee" | "refund" | "tax" | "supplier_spend" | "adjustment" | "unknown";

/** Immutable, allowlisted observations, not a reconciled profit ledger or raw seller export. */
export const etsyFinancialEvidence = pgTable("etsy_financial_evidence", {
  id: serial("id").primaryKey(),
  shopId: uuid("shop_id").notNull().references(() => shops.id),
  etsyShopId: text("etsy_shop_id").notNull(),
  listingId: integer("listing_id").references(() => listings.id),
  etsyListingId: text("etsy_listing_id"),
  receiptId: text("receipt_id"),
  sourceKind: text("source_kind").$type<"seller_export" | "normalized_ledger">().notNull(),
  sourceRef: text("source_ref").notNull(),
  observationRef: text("observation_ref").notNull(),
  ledgerType: text("ledger_type").notNull(),
  component: text("component").$type<FinancialComponent>().notNull(),
  status: text("status").$type<FinancialEvidenceStatus>().notNull(),
  amount: text("amount"),
  divisor: integer("divisor").notNull(),
  currency: text("currency").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  contentHash: text("content_hash").notNull(),
  importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("etsy_finance_source_observation").on(t.shopId, t.sourceKind, t.sourceRef, t.observationRef),
  index("etsy_finance_shop_date").on(t.shopId, t.occurredAt),
  check("etsy_finance_positive_divisor", sql`${t.divisor} > 0`),
  check("etsy_finance_currency", sql`${t.currency} ~ '^[A-Z]{3}$'`),
  check("etsy_finance_source_kind", sql`${t.sourceKind} IN ('seller_export', 'normalized_ledger')`),
  check("etsy_finance_component", sql`${t.component} IN ('revenue', 'fee', 'refund', 'tax', 'supplier_spend', 'adjustment', 'unknown')`),
  check("etsy_finance_status_amount", sql`(
    ${t.status} = 'unavailable' AND ${t.amount} IS NULL
  ) OR (
    ${t.status} IN ('actual', 'estimated') AND ${t.amount} IS NOT NULL AND ${t.amount} ~ '^-?(0|[1-9][0-9]{0,29})$'
  )`),
]);
