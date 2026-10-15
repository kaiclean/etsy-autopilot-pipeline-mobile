import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { shops } from "./schema";

export const etsyEvents = pgTable("etsy_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  deliveryKey: text("delivery_key").notNull(),
  source: text("source").$type<"webhook" | "operator">().notNull().default("webhook"),
  shopId: uuid("shop_id").notNull().references(() => shops.id),
  etsyShopId: text("etsy_shop_id").notNull(),
  eventType: text("event_type").notNull(),
  resourceType: text("resource_type").$type<"listing" | "receipt">().notNull(),
  resourceId: text("resource_id").notNull(),
  status: text("status").$type<"pending" | "processing" | "completed" | "dead_letter">().notNull().default("pending"),
  queueId: uuid("queue_id").notNull().defaultRandom(),
  dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  claimToken: uuid("claim_token"),
  errorCode: text("error_code"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("etsy_events_delivery_key_unique").on(t.deliveryKey),
  index("etsy_events_recovery_idx").on(t.status, t.nextAttemptAt),
]);

/** Sanitized source-of-truth observations, never a replacement for operator activation or Printify stock. */
export const etsyListingObservations = pgTable("etsy_listing_observations", {
  id: uuid("id").primaryKey().defaultRandom(),
  shopId: uuid("shop_id").notNull().references(() => shops.id),
  etsyListingId: text("etsy_listing_id").notNull(),
  state: text("state"),
  quantity: integer("quantity"),
  remoteUpdatedAt: timestamp("remote_updated_at", { withTimezone: true }),
  observedAt: timestamp("observed_at", { withTimezone: true }),
  fetchToken: uuid("fetch_token"),
}, (t) => [
  uniqueIndex("etsy_listing_observations_shop_listing_unique").on(t.shopId, t.etsyListingId),
]);

export type EtsyInboxEvent = typeof etsyEvents.$inferSelect;
