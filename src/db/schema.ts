import {
  boolean,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export type Niche = "alpine" | "gothic" | "christmas" | "birthday" | "stream";
export type ProductType = "digital" | "pod";
export type ListingStatus =
  | "pending_approval"
  | "approved"
  | "rejected"
  | "published"
  | "failed";
export type FulfillmentStatus =
  | "delivered_digital"
  | "pending"
  | "in_production"
  | "shipped"
  | "delivered";
export type StageName =
  | "research"
  | "design"
  | "listing"
  | "produce"
  | "publish"
  | "orders"
  | "analytics";

export type LogLine = { t: string; level: "info" | "warn" | "error"; msg: string };

/** One print-ready file the buyer downloads. Written by the Produce stage. */
export type Deliverable = {
  name: string;
  ratio: "2:3" | "3:4" | "4:5" | "11x14" | "ISO A";
  width: number;
  height: number;
  bytes: number;
  url: string;
  /** False when no object storage is configured: the file was rendered and measured but not kept. */
  stored: boolean;
  method: "resample" | "upscale";
  /** Enlargement from the original artwork to this file. */
  upscale: number;
};

export type ValidationIssue = {
  field: "title" | "tags" | "description" | "price" | "files";
  severity: "error" | "warning";
  code: string;
  message: string;
};

export const keywords = pgTable("keywords", {
  id: serial("id").primaryKey(),
  phrase: text("phrase").notNull().unique(),
  niche: text("niche").$type<Niche>().notNull(),
  source: text("source").notNull(),
  demandScore: doublePrecision("demand_score").notNull().default(0),
  competitionScore: doublePrecision("competition_score").notNull().default(0),
  seasonalityScore: doublePrecision("seasonality_score").notNull().default(0),
  trendScore: doublePrecision("trend_score"),
  score: doublePrecision("score").notNull().default(0),
  status: text("status").$type<"new" | "selected" | "used" | "rejected">().notNull().default("new"),
  isDemo: boolean("is_demo").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const designs = pgTable("designs", {
  id: serial("id").primaryKey(),
  keywordId: integer("keyword_id").references(() => keywords.id),
  niche: text("niche").$type<Niche>().notNull(),
  prompt: text("prompt").notNull(),
  provider: text("provider").notNull(),
  imageUrl: text("image_url").notNull(),
  status: text("status").$type<"generated" | "listed" | "discarded">().notNull().default("generated"),
  costChf: doublePrecision("cost_chf").notNull().default(0),
  isDemo: boolean("is_demo").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const listings = pgTable("listings", {
  id: serial("id").primaryKey(),
  designId: integer("design_id").references(() => designs.id),
  keywordId: integer("keyword_id").references(() => keywords.id),
  niche: text("niche").$type<Niche>().notNull(),
  productType: text("product_type").$type<ProductType>().notNull(),
  podProvider: text("pod_provider"),
  title: text("title").notNull(),
  tags: jsonb("tags").$type<string[]>().notNull(),
  description: text("description").notNull(),
  imageUrl: text("image_url").notNull(),
  priceChf: doublePrecision("price_chf").notNull(),
  podCostChf: doublePrecision("pod_cost_chf").notNull().default(0),
  netChf: doublePrecision("net_chf").notNull(),
  marginPct: doublePrecision("margin_pct").notNull(),
  validation: jsonb("validation").$type<ValidationIssue[]>().notNull().default([]),
  deliverables: jsonb("deliverables").$type<Deliverable[]>().notNull().default([]),
  status: text("status").$type<ListingStatus>().notNull().default("pending_approval"),
  rejectedReason: text("rejected_reason"),
  etsyListingId: text("etsy_listing_id"),
  printifyProductId: text("printify_product_id"),
  publishMode: text("publish_mode").$type<"dry-run" | "live">(),
  publishError: text("publish_error"),
  views: integer("views").notNull().default(0),
  favorites: integer("favorites").notNull().default(0),
  isDemo: boolean("is_demo").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  publishedAt: timestamp("published_at", { withTimezone: true }),
});

export const orders = pgTable("orders", {
  id: serial("id").primaryKey(),
  etsyReceiptId: text("etsy_receipt_id").notNull().unique(),
  listingId: integer("listing_id").references(() => listings.id),
  buyerCountry: text("buyer_country").notNull(),
  quantity: integer("quantity").notNull().default(1),
  totalChf: doublePrecision("total_chf").notNull(),
  feesChf: doublePrecision("fees_chf").notNull(),
  podCostChf: doublePrecision("pod_cost_chf").notNull().default(0),
  offsiteAdsChf: doublePrecision("offsite_ads_chf").notNull().default(0),
  profitChf: doublePrecision("profit_chf").notNull(),
  fulfillmentStatus: text("fulfillment_status").$type<FulfillmentStatus>().notNull(),
  podOrderId: text("pod_order_id"),
  isDemo: boolean("is_demo").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const jobRuns = pgTable("job_runs", {
  id: serial("id").primaryKey(),
  stage: text("stage").$type<StageName>().notNull(),
  status: text("status").$type<"running" | "success" | "failed" | "skipped">().notNull(),
  trigger: text("trigger").$type<"manual" | "cron" | "chain">().notNull(),
  summary: text("summary"),
  logs: jsonb("logs").$type<LogLine[]>().notNull().default([]),
  isDemo: boolean("is_demo").notNull().default(false),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const events = pgTable("events", {
  id: serial("id").primaryKey(),
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
  kind: text("kind").$type<"ai_image" | "ai_text" | "ads" | "listing_fee" | "other">().notNull(),
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

export type Keyword = typeof keywords.$inferSelect;
export type Design = typeof designs.$inferSelect;
export type Listing = typeof listings.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type JobRun = typeof jobRuns.$inferSelect;
export type AppEvent = typeof events.$inferSelect;
export type Cost = typeof costs.$inferSelect;
export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;
export type PrintifyEvent = typeof printifyEvents.$inferSelect;
