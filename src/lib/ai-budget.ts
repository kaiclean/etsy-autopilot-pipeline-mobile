import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { DB } from "@/db";
import { costs } from "@/db/schema";

export type AiBudgetReservation = { ok: true; reservationId: string } | { ok: false; reason: string };

/** Reserves before the provider request. Pending/uncertain work counts against both caps. */
export async function reserveAiBudget(db: DB, opts: {
  shopId: string; estimatedCostChf: number; estimatedNeurons?: number;
  dailyAiCapChf: number; monthlyAiBudgetChf: number; now: Date;
}): Promise<AiBudgetReservation> {
  const numbers = [opts.estimatedCostChf, opts.dailyAiCapChf, opts.monthlyAiBudgetChf, opts.estimatedNeurons ?? 0];
  if (numbers.some((n) => !Number.isFinite(n) || n < 0) || !Number.isInteger(opts.estimatedNeurons ?? 0) || !Number.isFinite(opts.now.getTime())) {
    return { ok: false, reason: "AI budget inputs must be finite nonnegative amounts" };
  }
  const id = randomUUID();
  const result = await db.execute(sql`
    SELECT reserve_runtime_ai_budget(${id}::uuid,${opts.shopId}::uuid,${opts.estimatedCostChf}::double precision,
      ${opts.estimatedNeurons ?? 0}::integer,${opts.dailyAiCapChf}::double precision,
      ${opts.monthlyAiBudgetChf}::double precision,${opts.now.toISOString()}::timestamptz) AS id
  `);
  return result.rows[0]?.id ? { ok: true, reservationId: id }
    : { ok: false, reason: "Daily/monthly AI cap or Workers AI 10,000-neuron allowance reached (including reserved work)" };
}

/** Release only before a request is sent; uncertain provider charges remain reserved. */
export async function finishAiBudgetReservation(db: DB, reservationId: string, state: "settled" | "uncertain" | "released") {
  await db.execute(sql`UPDATE runtime_ai_reservations SET state=${state},updated_at=now()
    WHERE id=${reservationId}::uuid AND state='pending'`);
}

/** Actual spend and the reservation's recorded part change in the same statement. */
export async function recordAiSpend(db: DB, opts: {
  shopId: string; kind: "ai_image" | "ai_text"; amountChf: number; note: string;
  isDemo: boolean; reservationId?: string; now?: Date;
}): Promise<void> {
  if (!Number.isFinite(opts.amountChf) || opts.amountChf < 0) throw new Error("Invalid AI charge");
  if (!opts.reservationId) {
    await db.insert(costs).values({ ...opts, ...(opts.now ? { createdAt: opts.now } : {}) });
    return;
  }
  const result = await db.execute(sql`
    WITH recorded AS (
      INSERT INTO costs(shop_id,kind,amount_chf,note,is_demo,created_at)
      SELECT ${opts.shopId}::uuid,${opts.kind},${opts.amountChf},${opts.note},${opts.isDemo},${(opts.now ?? new Date()).toISOString()}::timestamptz
      FROM runtime_ai_reservations WHERE id=${opts.reservationId}::uuid AND shop_id=${opts.shopId}::uuid AND state='pending'
      RETURNING amount_chf
    ) UPDATE runtime_ai_reservations SET recorded_cost_chf=recorded_cost_chf+(SELECT coalesce(sum(amount_chf),0) FROM recorded),updated_at=now()
      WHERE id=${opts.reservationId}::uuid AND shop_id=${opts.shopId}::uuid AND state='pending'
      RETURNING id
  `);
  if (!result.rows.length) throw new Error("AI charge reservation is unavailable or already closed");
}
