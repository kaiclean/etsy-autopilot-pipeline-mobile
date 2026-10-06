import { eq, sql } from "drizzle-orm";
import type { DB } from "@/db";
import { costs, dailyStats, events, jobRuns, orders } from "@/db/schema";
import { removableOrderWhere } from "@/lib/real-orders";

export type ClearCounts = {
  orders: number;
  costs: number;
  dailyStats: number;
  jobRuns: number;
  events: number;
};

function countValue(value: number | string | null | undefined) {
  return Number(value ?? 0);
}

async function countFakeRows(db: DB): Promise<ClearCounts> {
  const [orderRow] = await db.select({ n: sql<number>`count(*)::int` }).from(orders).where(removableOrderWhere());
  const [costRow] = await db.select({ n: sql<number>`count(*)::int` }).from(costs).where(eq(costs.isDemo, true));
  const [statRow] = await db.select({ n: sql<number>`count(*)::int` }).from(dailyStats).where(eq(dailyStats.isDemo, true));
  const [runRow] = await db.select({ n: sql<number>`count(*)::int` }).from(jobRuns).where(eq(jobRuns.isDemo, true));
  const [eventRow] = await db.select({ n: sql<number>`count(*)::int` }).from(events).where(eq(events.isDemo, true));
  return {
    orders: countValue(orderRow?.n),
    costs: countValue(costRow?.n),
    dailyStats: countValue(statRow?.n),
    jobRuns: countValue(runRow?.n),
    events: countValue(eventRow?.n),
  };
}

async function deleteFakeRows(db: DB) {
  await db.delete(orders).where(removableOrderWhere());
  await db.delete(costs).where(eq(costs.isDemo, true));
  await db.delete(dailyStats).where(eq(dailyStats.isDemo, true));
  await db.delete(jobRuns).where(eq(jobRuns.isDemo, true));
  await db.delete(events).where(eq(events.isDemo, true));
}

/** Neon HTTP has no interactive transactions. PGlite and node-postgres do. */
async function inTransaction(db: DB, fn: (tx: DB) => Promise<void>) {
  const runner = db as DB & { transaction?: (cb: (tx: DB) => Promise<void>) => Promise<void> };
  if (typeof runner.transaction !== "function") {
    await fn(db);
    return;
  }
  try {
    await runner.transaction(async (tx) => {
      await fn(tx);
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("No transactions support")) {
      await fn(db);
      return;
    }
    throw error;
  }
}

export function assertFakeOrderCleanupAllowed() {
  if (process.env.DEMO_MODE?.trim() === "true") {
    throw new Error("Refusing to clear fake orders while DEMO_MODE=true");
  }
}

/**
 * Count, then delete, seed and dry-run orders plus demo costs, daily stats, job runs, and events.
 * Listings, designs, and keywords are left in place. `--dry-run` only counts.
 */
export async function clearFakeOrders(db: DB, opts: { dryRun: boolean }): Promise<ClearCounts> {
  assertFakeOrderCleanupAllowed();
  if (opts.dryRun) return countFakeRows(db);
  let counts: ClearCounts = { orders: 0, costs: 0, dailyStats: 0, jobRuns: 0, events: 0 };
  await inTransaction(db, async (tx) => {
    counts = await countFakeRows(tx);
    await deleteFakeRows(tx);
  });
  return counts;
}

export function formatClearCounts(counts: ClearCounts) {
  return [
    `orders=${counts.orders}`,
    `costs=${counts.costs}`,
    `daily_stats=${counts.dailyStats}`,
    `job_runs=${counts.jobRuns}`,
    `events=${counts.events}`,
  ].join("\n");
}

function isCli() {
  const entry = process.argv[1] ?? "";
  return entry.endsWith("clear-fake-orders.ts") || entry.endsWith("clear-fake-orders.js");
}

async function main() {
  const { config: loadEnv } = await import("dotenv");
  loadEnv({ path: [".env.local", ".env"], quiet: true });
  assertFakeOrderCleanupAllowed();
  const dryRun = process.argv.includes("--dry-run");
  const { getDb } = await import("./index");
  const db = await getDb();
  const counts = await clearFakeOrders(db, { dryRun });
  console.log(formatClearCounts(counts));
}

if (isCli()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
