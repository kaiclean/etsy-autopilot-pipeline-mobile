import { sql } from "drizzle-orm";
import { check, doublePrecision, index, integer, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { shops } from "./schema";

export const runtimeStageLeases = pgTable("runtime_stage_leases", {
  shopId: uuid("shop_id").notNull().references(() => shops.id),
  stage: text("stage").notNull(), owner: uuid("owner").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => [primaryKey({ columns: [t.shopId, t.stage] })]);

export const runtimeAiBudgetMutex = pgTable("runtime_ai_budget_mutex", { id: integer("id").primaryKey() });

/** Unknown charges remain reserved until explicitly reconciled; never time them out into free budget. */
export const runtimeAiReservations = pgTable("runtime_ai_reservations", {
  id: uuid("id").primaryKey(), shopId: uuid("shop_id").notNull().references(() => shops.id),
  estimatedCostChf: doublePrecision("estimated_cost_chf").notNull(),
  recordedCostChf: doublePrecision("recorded_cost_chf").notNull().default(0),
  neurons: integer("neurons").notNull().default(0),
  state: text("state").$type<"pending" | "settled" | "uncertain" | "released">().notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("runtime_ai_reservations_shop_date_idx").on(t.shopId, t.createdAt),
  check("runtime_ai_reservations_estimated_cost_chf_check", sql`${t.estimatedCostChf} >= 0`),
  check("runtime_ai_reservations_recorded_cost_chf_check", sql`${t.recordedCostChf} >= 0`),
  check("runtime_ai_reservations_neurons_check", sql`${t.neurons} >= 0`),
  check("runtime_ai_reservations_state_check", sql`${t.state} IN ('pending','settled','uncertain','released')`),
]);
