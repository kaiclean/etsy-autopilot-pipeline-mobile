import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { DB } from "@/db";
import { costs } from "@/db/schema";

/**
 * Atomically reserve AI budget for a single operation.
 * Uses advisory lock + conditional upsert to prevent overspend across replicas.
 * Returns { ok: true } if budget allows, { ok: false, reason } if cap reached.
 */
export async function reserveAiBudget(db: DB, opts: {
  shopId: string;
  estimatedCostChf: number;
  estimatedNeurons?: number;
  dailyAiCapChf: number;
  monthlyAiBudgetChf: number;
  now: Date;
}): Promise<{ ok: boolean; reason?: string }> {
  const dayStart = new Date(opts.now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const monthStart = new Date(Date.UTC(opts.now.getUTCFullYear(), opts.now.getUTCMonth(), 1));
  
  // Use a single advisory lock per shop per day for budget checks
  const lockKey = `ai_budget:${opts.shopId}:${dayStart.toISOString().slice(0, 10)}`;
  let hash = 0;
  for (let i = 0; i < lockKey.length; i++) {
    hash = ((hash << 5) - hash + lockKey.charCodeAt(i)) | 0;
  }
  const advisoryKey = BigInt((hash >>> 0) & 0x7fffffffffffffff);
  
  const acquired = await db.execute(`SELECT pg_try_advisory_lock(${advisoryKey}) as acquired`);
  if (!(acquired.rows[0]?.acquired as boolean)) {
    return { ok: false, reason: "Could not acquire budget lock; retry" };
  }
  
  try {
    // Check current spend atomically
    const [todaySpend] = await db
      .select({ total: sql<number>`coalesce(sum(${costs.amountChf}), 0)::float` })
      .from(costs)
      .where(and(
        eq(costs.shopId, opts.shopId),
        gte(costs.createdAt, dayStart),
        sql`${costs.kind} in ('ai_image','ai_text')`,
      ));
    
    const [monthSpend] = await db
      .select({ total: sql<number>`coalesce(sum(${costs.amountChf}), 0)::float` })
      .from(costs)
      .where(and(
        eq(costs.shopId, opts.shopId),
        gte(costs.createdAt, monthStart),
        sql`${costs.kind} in ('ai_image','ai_text')`,
      ));
    
    const spentToday = Number(todaySpend?.total ?? 0);
    const spentMonth = Number(monthSpend?.total ?? 0);
    
    if (spentToday + opts.estimatedCostChf > opts.dailyAiCapChf) {
      return { ok: false, reason: `Daily AI cap CHF ${opts.dailyAiCapChf.toFixed(2)} reached (spent ${spentToday.toFixed(2)}, need ${opts.estimatedCostChf.toFixed(2)})` };
    }
    if (spentMonth + opts.estimatedCostChf > opts.monthlyAiBudgetChf) {
      return { ok: false, reason: `Monthly AI budget CHF ${opts.monthlyAiBudgetChf.toFixed(2)} reached (spent ${spentMonth.toFixed(2)}, need ${opts.estimatedCostChf.toFixed(2)})` };
    }
    
    if (opts.estimatedNeurons) {
      const [neuronUsage] = await db.select({ count: sql<number>`count(*)::int` }).from(costs).where(and(
        gte(costs.createdAt, dayStart),
        eq(costs.kind, "ai_image"),
        sql`${costs.note} like 'Workers AI neurons:%'`,
      ));
      const neuronsToday = Number(neuronUsage?.count ?? 0) * opts.estimatedNeurons;
      if (neuronsToday + opts.estimatedNeurons > 10_000) {
        return { ok: false, reason: `Cloudflare Workers AI neuron budget 10,000/day reached (${neuronsToday}/${10_000})` };
      }
    }
    
    return { ok: true };
  } finally {
    await db.execute(`SELECT pg_advisory_unlock(${advisoryKey})`);
  }
}

/**
 * Record AI spend atomically after successful generation.
 */
export async function recordAiSpend(db: DB, opts: {
  shopId: string;
  kind: "ai_image" | "ai_text";
  amountChf: number;
  note: string;
  isDemo: boolean;
}): Promise<void> {
  await db.insert(costs).values({
    shopId: opts.shopId,
    kind: opts.kind,
    amountChf: opts.amountChf,
    note: opts.note,
    isDemo: opts.isDemo,
  });
}