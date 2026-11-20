import { sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  integer,
  index,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { keywords, listings, orders, shops, type LogLine, type StageName } from "./schema-core";

const omnishopId = sql`current_omnishop_id()`;

/** Dedupes the web-push for a real Etsy receipt. Demo and dry-run ids are never inserted. */
export const saleAlerts = pgTable("sale_alerts", {
  etsyReceiptId: text("etsy_receipt_id").primaryKey(),
  shopId: uuid("shop_id").references(() => shops.id),
  alertedAt: timestamp("alerted_at", { withTimezone: true }).notNull().defaultNow(),
});

export const jobRuns = pgTable("job_runs", {
  id: serial("id").primaryKey(),
  shopId: uuid("shop_id")
    .notNull()
    .default(omnishopId)
    .references(() => shops.id),
  keywordId: integer("keyword_id").references(() => keywords.id),
  stage: text("stage").$type<StageName>().notNull(),
  status: text("status").$type<"running" | "success" | "warning" | "failed" | "skipped">().notNull(),
  trigger: text("trigger").$type<"manual" | "cron" | "chain">().notNull(),
  summary: text("summary"),
  logs: jsonb("logs").$type<LogLine[]>().notNull().default([]),
  isDemo: boolean("is_demo").notNull().default(false),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const events = pgTable("events", {
  id: serial("id").primaryKey(),
  shopId: uuid("shop_id")
    .notNull()
    .default(omnishopId)
    .references(() => shops.id),
  type: text("type").notNull(),
  title: text("title").notNull(),
  body: text("body"),
  severity: text("severity").$type<"info" | "success" | "warning" | "error">().notNull().default("info"),
  href: text("href"),
  isDemo: boolean("is_demo").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const costs = pgTable("costs", {
  id: serial("id").primaryKey(),
  shopId: uuid("shop_id")
    .notNull()
    .default(omnishopId)
    .references(() => shops.id),
  kind: text("kind").$type<"ai_image" | "ai_text" | "ads_estimate" | "ads_actual" | "listing_fee" | "other">().notNull(),
  amountChf: doublePrecision("amount_chf").notNull(),
  note: text("note"),
  isDemo: boolean("is_demo").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const dailyStats = pgTable("daily_stats", {
  id: serial("id").primaryKey(),
  date: text("date").notNull(),
  views: integer("views").notNull().default(0),
  favorites: integer("favorites").notNull().default(0),
  isDemo: boolean("is_demo").notNull().default(false),
});

/**
 * A physical sample Kai has approved for one Printify blueprint + print provider.
 * Publishing that pair to Etsy is blocked until a row exists.
 */
export const podSamples = pgTable(
  "pod_samples",
  {
    id: serial("id").primaryKey(),
    blueprintId: integer("blueprint_id").notNull(),
    providerId: integer("provider_id").notNull(),
    note: text("note"),
    approvedAt: timestamp("approved_at", { withTimezone: true }).notNull(),
    approvedBy: text("approved_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("pod_samples_blueprint_provider").on(t.blueprintId, t.providerId)],
);

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Browser Push API subscriptions. One row per device endpoint. */
export const pushSubscriptions = pgTable("push_subscriptions", {
  id: serial("id").primaryKey(),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Idempotent Printify webhook log. Buyer contact fields are stripped before insert.
 * Maps Printify product/order ids onto Etsy listing and receipt ids when the payload has them.
 */
export const printifyEvents = pgTable("printify_events", {
  id: serial("id").primaryKey(),
  eventId: text("event_id").notNull().unique(),
  topic: text("topic").notNull(),
  printifyProductId: text("printify_product_id"),
  printifyOrderId: text("printify_order_id"),
  etsyListingId: text("etsy_listing_id"),
  etsyOrderId: text("etsy_order_id"),
  listingId: integer("listing_id").references(() => listings.id),
  orderId: integer("order_id").references(() => orders.id),
  verified: boolean("verified").notNull().default(false),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type JobRun = typeof jobRuns.$inferSelect;

export type AppEvent = typeof events.$inferSelect;

export type Cost = typeof costs.$inferSelect;

export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;

export type PrintifyEvent = typeof printifyEvents.$inferSelect;

export const publishDeadLetters = pgTable(
  "publish_dead_letters",
  {
    id: serial("id").primaryKey(),
    shopId: uuid("shop_id")
      .notNull()
      .default(omnishopId)
      .references(() => shops.id),
    listingId: integer("listing_id").references(() => listings.id),
    stage: text("stage").$type<"digital" | "pod">().notNull(),
    error: text("error").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    resolved: boolean("resolved").notNull().default(false),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: text("resolved_by"),
    resolution: text("resolution"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("publish_dead_letters_listing_idx").on(t.listingId),
    index("publish_dead_letters_shop_idx").on(t.shopId),
    uniqueIndex("publish_dead_letters_unresolved_idx").on(t.listingId).where(sql`${t.resolved} = false`),
  ],
);

export type PodSample = typeof podSamples.$inferSelect;

export type PublishDeadLetter = typeof publishDeadLetters.$inferSelect;

export type SaleAlert = typeof saleAlerts.$inferSelect;
