import { boolean, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { brainSessions, shops, type StageName } from "./schema";

export type BoxJobStatus = "queued" | "running" | "succeeded" | "failed" | "held";
export const boxJobs = pgTable("box_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  shopId: uuid("shop_id").notNull().references(() => shops.id),
  stage: text("stage").$type<StageName | "all">().notNull(),
  trigger: text("trigger").$type<"manual" | "cron">().notNull(),
  force: boolean("force").notNull().default(false),
  sessionId: integer("session_id").references(() => brainSessions.id),
  idempotencyKey: text("idempotency_key").notNull(),
  status: text("status").$type<BoxJobStatus>().notNull().default("queued"),
  owner: uuid("owner"),
  attempts: integer("attempts").notNull().default(0),
  summary: text("summary"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
}, (t) => [
  uniqueIndex("box_jobs_idempotency_idx").on(t.shopId, t.idempotencyKey),
  index("box_jobs_status_idx").on(t.status, t.createdAt),
]);
export type BoxJob = typeof boxJobs.$inferSelect;
