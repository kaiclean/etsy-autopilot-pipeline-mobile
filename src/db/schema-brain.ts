import type { BrainProductOrigin } from "@/lib/brain/product-origin";
import {
  boolean,
  integer,
  index,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { designBriefs, keywords, type Niche, type StageName } from "./schema-core";

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
  brainOrigin: jsonb("brain_origin").$type<BrainProductOrigin>(),
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

/** A presigned S3 key is valid only for the design it was issued for, and only once. */
export const upscaleUploads = pgTable("upscale_uploads", {
  key: text("key").primaryKey(),
  designId: integer("design_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
});

/** Live worker imports supplement the bundled historical vault without redeploying. */
export const brainVaultNotes = pgTable("brain_vault_notes", {
  id: text("id").primaryKey(),
  markdown: text("markdown").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

