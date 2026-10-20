import { sql } from "drizzle-orm";
import type { ArtworkProvenance } from "@/lib/artwork-provenance";
import type { ArtworkPackManifest } from "@/lib/artwork-pack";
import type { ProviderDetails } from "@/lib/disclosures";
import type { ArtworkGalleryView } from "@/pipeline/mockup";
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

export type Niche = "alpine" | "gothic" | "christmas" | "birthday" | "stream";
export type ProductType = "digital" | "pod";
export type ListingStatus =
  | "pending_approval"
  | "approved"
  | "rejected"
  | "pod_created"
  | "publishing"
  | "published"
  | "failed"
  | "quality_failed";

/** Recorded bytes for the file a digital buyer downloads, plus the smaller gallery preview. */
export type DeliveryFileRecord = {
  filename: string;
  format?: "png" | "jpeg" | "webp";
  width: number;
  height: number;
  bytes: number;
  sha256: string;
};

export type FileManifest = {
  delivery: DeliveryFileRecord;
  preview?: DeliveryFileRecord;
};

/** Receipt linked to a pipeline listing, or kept until that Etsy id shows up. */
export type OrderMatchStatus = "matched" | "unmatched";
export type FulfillmentStatus =
  | "delivered_digital"
  | "pending"
  | "in_production"
  | "shipped"
  | "delivered";
export type StageName =
  | "research"
  | "hot"
  | "design"
  | "listing"
  | "publish"
  | "orders"
  | "analytics"
  | "maintenance"
  | "daily"
  | "health";

export type LogLine = { t: string; level: "info" | "warn" | "error"; msg: string };

export type ShopStatus = "draft" | "connecting" | "dry-run" | "live" | "paused" | "archived";
export type ShopPublishMode = "dry-run" | "live";
export type ShopProvider = "etsy" | "printify" | "s3" | "openrouter";
export type ShopConnectionStatus = "connected" | "configured" | "missing" | "error";

/** Default for rows created before a request passes an explicit shop id. */
const omnishopId = sql`current_omnishop_id()`;

export const shops = pgTable("shops", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  displayName: text("display_name").notNull(),
  etsyShopId: text("etsy_shop_id").unique(),
  etsyShopName: text("etsy_shop_name"),
  currency: text("currency").notNull().default("CHF"),
  locale: text("locale").notNull().default("en"),
  marketLocale: text("market_locale"),
  status: text("status").$type<ShopStatus>().notNull().default("dry-run"),
  publishMode: text("publish_mode").$type<ShopPublishMode>().notNull().default("dry-run"),
  killSwitch: boolean("kill_switch").notNull().default(false),
  brandBriefRef: text("brand_brief_ref"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const shopConnections = pgTable(
  "shop_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id),
    provider: text("provider").$type<ShopProvider>().notNull(),
    status: text("status").$type<ShopConnectionStatus>().notNull(),
    secretsRef: text("secrets_ref").notNull(),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
    tokens: jsonb("tokens").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("shop_connections_shop_provider").on(t.shopId, t.provider)],
);

export const shopAutomation = pgTable("shop_automation", {
  shopId: uuid("shop_id")
    .primaryKey()
    .references(() => shops.id),
  automation: jsonb("automation").$type<Record<string, unknown>>().notNull(),
  stages: jsonb("stages").$type<Record<string, unknown>>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ValidationIssue = {
  field: "title" | "tags" | "description" | "price" | "image";
  severity: "error" | "warning";
  code: string;
  message: string;
};

export const keywords = pgTable("keywords", {
  id: serial("id").primaryKey(),
  shopId: uuid("shop_id")
    .notNull()
    .default(omnishopId)
    .references(() => shops.id),
  phrase: text("phrase").notNull().unique(),
  niche: text("niche").$type<Niche>().notNull(),
  source: text("source").notNull(),
  demandScore: doublePrecision("demand_score").notNull().default(0),
  competitionScore: doublePrecision("competition_score").notNull().default(0),
  seasonalityScore: doublePrecision("seasonality_score").notNull().default(0),
  trendScore: doublePrecision("trend_score"),
  score: doublePrecision("score").notNull().default(0),
  status: text("status").$type<"new" | "selected" | "used" | "rejected">().notNull().default("new"),
  /** Provider attempts that did not produce a design. Research prefers a lower count. */
  designFailures: integer("design_failures").notNull().default(0),
  /** Theme registry row (themes.id) this keyword came from; null for plain niche research. */
  themeId: text("theme_id"),
  isDemo: boolean("is_demo").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const hotSignals = pgTable("hot_signals", {
  id: serial("id").primaryKey(),
  shopId: uuid("shop_id").references(() => shops.id),
  provider: text("provider").notNull(),
  category: text("category"),
  title: text("title").notNull(),
  phrase: text("phrase").notNull(),
  niche: text("niche").$type<Niche>(),
  rank: integer("rank"),
  badge: text("badge"),
  labelText: text("label_text"),
  metric: doublePrecision("metric"),
  score: doublePrecision("score"),
  sourceUrl: text("source_url").notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("hot_signals_fetched_idx").on(table.fetchedAt.desc()),
  uniqueIndex("hot_signals_dedupe").on(table.provider, table.sourceUrl, sql`((${table.fetchedAt} AT TIME ZONE 'UTC')::date)`),
]);

/** Cache successful empty scans too, without fabricating an observation. Market signals are shared across shops. */
export const hotSignalFetches = pgTable("hot_signal_fetches", {
  provider: text("provider").primaryKey(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
});

export const designs = pgTable("designs", {
  id: serial("id").primaryKey(),
  shopId: uuid("shop_id")
    .notNull()
    .default(omnishopId)
    .references(() => shops.id),
  keywordId: integer("keyword_id").references(() => keywords.id),
  niche: text("niche").$type<Niche>().notNull(),
  prompt: text("prompt").notNull(),
  provider: text("provider").notNull(),
  imageUrl: text("image_url").notNull(),
  provenance: jsonb("provenance").$type<ArtworkProvenance>(),
  imageWidth: integer("image_width"),
  imageHeight: integer("image_height"),
  sourceImageUrl: text("source_image_url"),
  sourcePx: jsonb("source_px").$type<{ width: number; height: number }>(),
  outputPx: jsonb("output_px").$type<{ width: number; height: number }>(),
  upscaleMethod: text("upscale_method").$type<"realesrgan" | "lanczos" | "native">(),
  printTarget: jsonb("print_target").$type<{ minW: number; minH: number; targetW: number; targetH: number }>(),
  colorVariance: doublePrecision("color_variance"),
  /** Set when no 4× Real-ESRGAN pass can reach the print target; Design rebuilds at full size. */
  needsRedesign: jsonb("needs_redesign").$type<{ reason: string; sourcePx: { width: number; height: number }; target: { minW: number; minH: number; targetW: number; targetH: number }; presets: string[]; scale: number; at: string }>(),
  qualityScore: integer("quality_score"),
  qualityReasons: jsonb("quality_reasons").$type<string[]>().notNull().default([]),
  status: text("status").$type<"generated" | "listed" | "discarded" | "rejected" | "needs_review">().notNull().default("generated"),
  costChf: doublePrecision("cost_chf").notNull().default(0),
  isDemo: boolean("is_demo").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const listings = pgTable("listings", {
  id: serial("id").primaryKey(),
  shopId: uuid("shop_id")
    .notNull()
    .default(omnishopId)
    .references(() => shops.id),
  designId: integer("design_id").references(() => designs.id),
  keywordId: integer("keyword_id").references(() => keywords.id),
  niche: text("niche").$type<Niche>().notNull(),
  productType: text("product_type").$type<ProductType>().notNull(),
  podProvider: text("pod_provider"),
  supplier: text("supplier"),
  supplierProductId: text("supplier_product_id"),
  title: text("title").notNull(),
  tags: jsonb("tags").$type<string[]>().notNull(),
  description: text("description").notNull(),
  imageUrl: text("image_url").notNull(),
  /** Full-resolution digital file. The gallery `imageUrl` must be a different preview. */
  deliveryUrl: text("delivery_url"),
  fileManifest: jsonb("file_manifest").$type<FileManifest>(),
  deliveryPack: jsonb("delivery_pack").$type<ArtworkPackManifest>(),
  etsyDeliveryFingerprint: text("etsy_delivery_fingerprint"),
  gallery: jsonb("gallery").$type<ArtworkGalleryView[]>().notNull().default([]),
  copyProvenance: jsonb("copy_provenance").$type<{ version: 1; provider: string; inputSha256: string; providerDetails?: ProviderDetails | null }>(),
  fileVerifiedAt: timestamp("file_verified_at", { withTimezone: true }),
  fileVerifiedBy: text("file_verified_by"),
  /** Set only by the per-listing Activate action. Cron never sets this. */
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  podBlueprintId: integer("pod_blueprint_id"),
  podPrintProviderId: integer("pod_print_provider_id"),
  /** Set when a human publishes the Printify product to Etsy. */
  podPublishedAt: timestamp("pod_published_at", { withTimezone: true }),
  priceChf: doublePrecision("price_chf").notNull(),
  podCostChf: doublePrecision("pod_cost_chf").notNull().default(0),
  netChf: doublePrecision("net_chf").notNull(),
  marginPct: doublePrecision("margin_pct").notNull(),
  validation: jsonb("validation").$type<ValidationIssue[]>().notNull().default([]),
  status: text("status").$type<ListingStatus>().notNull().default("pending_approval"),
  rejectedReason: text("rejected_reason"),
  etsyListingId: text("etsy_listing_id"),
  printifyProductId: text("printify_product_id"),
  publishMode: text("publish_mode").$type<"dry-run" | "live">(),
  publishError: text("publish_error"),
  /** Last time publish actually called Etsy or Printify. Same-error retries wait 24h from here. */
  publishAttemptedAt: timestamp("publish_attempted_at", { withTimezone: true }),
  publishAttemptCount: integer("publish_attempt_count").notNull().default(0),
  /** Set once, when a POD row has waited >24h for an Etsy id, so the alert does not repeat. */
  etsyIdWaitAlertedAt: timestamp("etsy_id_wait_alerted_at", { withTimezone: true }),
  views: integer("views").notNull().default(0),
  favorites: integer("favorites").notNull().default(0),
  analyticsCheckedAt: timestamp("analytics_checked_at", { withTimezone: true }),
  isDemo: boolean("is_demo").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  publishedAt: timestamp("published_at", { withTimezone: true }),
});

export const supplierProducts = pgTable(
  "supplier_products",
  {
    id: serial("id").primaryKey(),
    supplier: text("supplier").notNull(),
    preset: text("preset").notNull(),
    externalProductUid: text("external_product_uid").notNull(),
    title: text("title"),
    baseCostUsd: doublePrecision("base_cost_usd"),
    currency: text("currency"),
    sourceUrl: text("source_url"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
  },
  (t) => [unique("supplier_products_supplier_preset_external_product_uid_key").on(t.supplier, t.preset, t.externalProductUid)],
);

export const supplierQuotes = pgTable("supplier_quotes", {
  id: serial("id").primaryKey(),
  supplier: text("supplier").notNull(),
  preset: text("preset").notNull(),
  region: text("region").notNull(),
  destinationCountry: text("destination_country"),
  providerRef: text("provider_ref"),
  inStock: boolean("in_stock"),
  baseCostUsd: doublePrecision("base_cost_usd"),
  shippingUsd: doublePrecision("shipping_usd"),
  productionDays: integer("production_days"),
  currency: text("currency"),
  sourceUrl: text("source_url"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
});

export const sourcingChoices = pgTable("sourcing_choices", {
  id: serial("id").primaryKey(),
  preset: text("preset").notNull(),
  region: text("region").notNull(),
  supplier: text("supplier").notNull(),
  providerRef: text("provider_ref"),
  landedCostChf: doublePrecision("landed_cost_chf"),
  quoteId: integer("quote_id").references(() => supplierQuotes.id),
  reason: text("reason"),
  chosenAt: timestamp("chosen_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("sourcing_choices_preset_region_key").on(t.preset, t.region)]);

export const orders = pgTable("orders", {
  id: serial("id").primaryKey(),
  shopId: uuid("shop_id")
    .notNull()
    .default(omnishopId)
    .references(() => shops.id),
  etsyReceiptId: text("etsy_receipt_id").notNull().unique(),
  etsyPaymentStatus: text("etsy_payment_status").$type<"paid" | "unpaid" | "canceled" | "refund_pending">().notNull().default("paid"),
  listingId: integer("listing_id").references(() => listings.id),
  /** Etsy listing id from the receipt when no pipeline row has that id yet. */
  unmatchedEtsyListingId: text("unmatched_etsy_listing_id"),
  matchStatus: text("match_status").$type<OrderMatchStatus>().notNull().default("matched"),
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
  /** Clock for Printify status progress. Stall watch uses this, not a generic row touch. */
  fulfillmentChangedAt: timestamp("fulfillment_changed_at", { withTimezone: true }),
  /** Set once when a Printify order has had no status progress for 48 hours. */
  fulfillmentStalledAt: timestamp("fulfillment_stalled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One brief per keyword. The daily chain reuses it instead of drafting a second product. */
export const designBriefs = pgTable(
  "design_briefs",
  {
    id: serial("id").primaryKey(),
    shopId: uuid("shop_id")
      .notNull()
      .default(omnishopId)
      .references(() => shops.id),
    keywordId: integer("keyword_id")
      .notNull()
      .references(() => keywords.id),
    niche: text("niche").$type<Niche>().notNull(),
    prompt: text("prompt").notNull(),
    concept: text("concept"),
    productType: text("product_type").$type<ProductType>().notNull(),
    podPreset: text("pod_preset"),
    dayKey: text("day_key").notNull(),
    status: text("status").$type<"briefed" | "designed">().notNull().default("briefed"),
    isDemo: boolean("is_demo").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("design_briefs_keyword_id_unique").on(t.keywordId)],
);

export type HealthSuggestion = {
  listingId: number;
  title: string;
  action: "refresh" | "retire";
  reason: string;
};

export type HealthReportPayload = {
  weekStart: string;
  windowStart: string;
  windowEnd: string;
  views: number;
  favorites: number;
  sales: number;
  profitChf: number;
  vatChf: number;
  podCostChf: number;
  adsChf: number;
  /** Optional for health reports saved before ad estimates and actuals were split. */
  adsEstimateChf?: number;
  adsActualChf?: number;
  suggestions: HealthSuggestion[];
};

/** One Monday report per shop per week. Re-runs update the same row. */
export const healthReports = pgTable(
  "health_reports",
  {
    id: serial("id").primaryKey(),
    shopId: uuid("shop_id")
      .notNull()
      .default(omnishopId)
      .references(() => shops.id),
    weekStart: text("week_start").notNull(),
    payload: jsonb("payload").$type<HealthReportPayload>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("health_reports_shop_week").on(t.shopId, t.weekStart)],
);

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

export type Shop = typeof shops.$inferSelect;
export type ShopConnection = typeof shopConnections.$inferSelect;
export type Keyword = typeof keywords.$inferSelect;
export type Design = typeof designs.$inferSelect;
export type Listing = typeof listings.$inferSelect;
export type SupplierProduct = typeof supplierProducts.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type JobRun = typeof jobRuns.$inferSelect;
export type AppEvent = typeof events.$inferSelect;
export type Cost = typeof costs.$inferSelect;
export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;
export type PrintifyEvent = typeof printifyEvents.$inferSelect;
export type PodSample = typeof podSamples.$inferSelect;
export type DesignBrief = typeof designBriefs.$inferSelect;
export type HealthReport = typeof healthReports.$inferSelect;
export type SaleAlert = typeof saleAlerts.$inferSelect;

/**
 * OmniGram Brain: Kai's verdicts on vault ideas (Ideas/<name>). Append-only; the latest row per idea wins.
 * An approved idea that fits an active niche links the keyword and design brief it created.
 */
export const brainDecisions = pgTable("brain_decisions", {
  id: serial("id").primaryKey(),
  ideaId: text("idea_id").notNull(),
  verdict: text("verdict").$type<"approved" | "rejected" | "needs_research">().notNull(),
  comment: text("comment"),
  priority: integer("priority"),
  /** Search phrase Kai confirmed in the approve form; null for backlog-only approvals. */
  phrase: text("phrase"),
  niche: text("niche").$type<Niche>(),
  keywordId: integer("keyword_id").references(() => keywords.id),
  designBriefId: integer("design_brief_id").references(() => designBriefs.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("brain_decisions_idea_idx").on(table.ideaId, table.createdAt.desc()),
  index("brain_decisions_created_idx").on(table.createdAt),
]);
export type BrainDecision = typeof brainDecisions.$inferSelect;

export type ThemeStatus = "proposed" | "active" | "paused" | "retired";
export type ThemeProduct = "wall-art" | "poster" | "pod-apparel" | "pod-mug" | "planner" | "template" | "prompt-pack";

/**
 * Editable theme registry. A theme rides on a production niche (`base_niche`) whose product mix,
 * prices and delivery rules the pipeline already enforces; the theme adds its own look and seed phrases.
 * Only `active` themes feed research. `proposed` rows come from the daily idea step and wait for Kai.
 */
export const themes = pgTable("themes", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  baseNiche: text("base_niche").$type<Niche>().notNull(),
  status: text("status").$type<ThemeStatus>().notNull().default("proposed"),
  /** Image prompt look; null = the base niche look. */
  style: text("style"),
  seeds: jsonb("seeds").$type<string[]>().notNull().default([]),
  products: jsonb("products").$type<ThemeProduct[]>().notNull().default([]),
  /** Month indexes 0-11; empty = evergreen. */
  peakMonths: jsonb("peak_months").$type<number[]>().notNull().default([]),
  /** Why it cannot run yet (missing real files etc). Research skips themes with a blocker. */
  blocker: text("blocker"),
  notes: text("notes"),
  source: text("source").notNull().default("manual"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type Theme = typeof themes.$inferSelect;

/** Daily idea step output: candidate ideas Kai approves (into the pipeline) or rejects. */
export const ideaCandidates = pgTable("idea_candidates", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  title: text("title").notNull(),
  phrase: text("phrase").notNull(),
  themeId: text("theme_id"),
  niche: text("niche").$type<Niche>(),
  product: text("product").$type<ThemeProduct>(),
  rationale: text("rationale").notNull(),
  source: text("source").notNull(),
  status: text("status").$type<"pending" | "approved" | "rejected">().notNull().default("pending"),
  keywordId: integer("keyword_id").references(() => keywords.id),
  designBriefId: integer("design_brief_id").references(() => designBriefs.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
}, (table) => [index("idea_candidates_status_idx").on(table.status, table.createdAt)]);
export type IdeaCandidate = typeof ideaCandidates.$inferSelect;

/** Stage runs started from the Brain → Sessions page. Never publishes live. */
export const brainSessions = pgTable("brain_sessions", {
  id: serial("id").primaryKey(),
  stage: text("stage").$type<StageName>().notNull(),
  status: text("status").$type<"queued" | "running" | "success" | "warning" | "failed" | "skipped" | "cancelled">().notNull().default("queued"),
  jobRunId: integer("job_run_id"),
  summary: text("summary"),
  retryOf: integer("retry_of"),
  taskId: integer("task_id"),
  cancelRequested: boolean("cancel_requested").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

/** Kai's task list, assigned by pipeline stage. */
export const brainTasks = pgTable("brain_tasks", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  notes: text("notes"),
  stage: text("stage").$type<StageName>().notNull().default("research"),
  status: text("status").$type<"todo" | "doing" | "done">().notNull().default("todo"),
  lastSessionId: integer("last_session_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Per-day generation counters, e.g. "cloudflare:2026-10-20" and "redesign:2026-10-20". Incremented by one row-locked upsert. */
export const imageQuota = pgTable("image_quota", {
  key: text("key").primaryKey(),
  used: integer("used").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
