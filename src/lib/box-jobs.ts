import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { DB } from "@/db";
import { boxJobs, type BoxJob } from "@/db/box-jobs";
import { isStage, type StageName } from "@/pipeline/types";
import { stageSucceededToday } from "@/pipeline/chain-day";
import { getSetting, type StageSettings } from "@/lib/settings";

export type { BoxJob, BoxJobStatus } from "@/db/box-jobs";
export const BOX_LEASE_MS = 10 * 60_000;
export const BOX_MAX_ATTEMPTS = 3;
export function boxExecutionEnabled() { return process.env.AUTOPILOT_EXECUTION === "box"; }

export async function enqueueBoxJob(db: DB, opts: {
  shopId: string; stage: StageName | "all"; trigger: "manual" | "cron";
  force?: boolean; idempotencyKey?: string; sessionId?: number;
}): Promise<BoxJob> {
  if (opts.stage !== "all" && !isStage(opts.stage)) throw new Error("Unknown pipeline stage");
  const key = opts.idempotencyKey ?? `manual:${randomUUID()}`;
  if (!key || key.length > 200) throw new Error("Invalid job idempotency key");
  const [created] = await db.insert(boxJobs).values({
    shopId: opts.shopId, stage: opts.stage, trigger: opts.trigger, force: opts.force ?? false,
    sessionId: opts.sessionId ?? null, idempotencyKey: key,
    summary: "Queued for the local box. Publish approvals remain required.",
  }).onConflictDoNothing({ target: [boxJobs.shopId, boxJobs.idempotencyKey] }).returning();
  if (created) return created;
  const [existing] = await db.select().from(boxJobs).where(and(eq(boxJobs.shopId, opts.shopId), eq(boxJobs.idempotencyKey, key)));
  if (!existing || existing.stage !== opts.stage || existing.trigger !== opts.trigger || existing.force !== (opts.force ?? false) || existing.sessionId !== (opts.sessionId ?? null)) {
    throw new Error("Idempotency key was already used for a different job");
  }
  return existing;
}

export async function listBoxJobs(db: DB, shopId: string, limit = 20) {
  return db.select().from(boxJobs).where(eq(boxJobs.shopId, shopId)).orderBy(desc(boxJobs.createdAt)).limit(Math.max(1, Math.min(100, limit)));
}

/** Expired work is uncertain: never replay a possibly completed provider write automatically. */
export async function holdExpiredBoxJobs(db: DB, now = new Date()) {
  return db.update(boxJobs).set({ status: "held", finishedAt: now, summary: "Worker lease expired. Inspect provider results before explicitly retrying this job." })
    .where(and(eq(boxJobs.status, "running"), sql`${boxJobs.leaseUntil} <= ${now}`)).returning({ id: boxJobs.id });
}

/** One SQL statement locks a queue row and acquires the shop lease on every supported DB driver. */
export async function claimBoxJob(db: DB, owner: string, now = new Date(), shopId?: string): Promise<BoxJob | null> {
  await holdExpiredBoxJobs(db, now);
  const leaseUntil = new Date(now.getTime() + BOX_LEASE_MS);
  const result = await db.execute(sql`
    WITH candidate AS (
      SELECT j.id, j.shop_id FROM box_jobs j
      WHERE j.status = 'queued' AND j.attempts < ${BOX_MAX_ATTEMPTS}
        ${shopId ? sql`AND j.shop_id = ${shopId}::uuid` : sql``}
        AND NOT EXISTS (SELECT 1 FROM box_jobs h WHERE h.shop_id = j.shop_id AND h.status = 'held')
        AND NOT EXISTS (SELECT 1 FROM box_shop_leases l WHERE l.shop_id = j.shop_id AND l.lease_until > ${now})
      ORDER BY j.created_at, j.id LIMIT 1 FOR UPDATE SKIP LOCKED
    ), lease AS (
      INSERT INTO box_shop_leases (shop_id, owner, lease_until)
      SELECT shop_id, ${owner}::uuid, ${leaseUntil} FROM candidate
      ON CONFLICT (shop_id) DO UPDATE SET owner = EXCLUDED.owner, lease_until = EXCLUDED.lease_until
      WHERE box_shop_leases.lease_until <= ${now}
      RETURNING shop_id
    )
    UPDATE box_jobs j SET status = 'running', owner = ${owner}::uuid, lease_until = ${leaseUntil},
      attempts = attempts + 1, started_at = ${now}, finished_at = NULL, summary = 'Running on the local box'
    FROM candidate c, lease l WHERE j.id = c.id AND j.shop_id = l.shop_id AND j.status = 'queued'
    RETURNING j.id
  `);
  const id = result.rows[0]?.id as string | undefined;
  if (!id) return null;
  const [job] = await db.select().from(boxJobs).where(eq(boxJobs.id, id));
  return job ?? null;
}

export async function heartbeatBoxJob(db: DB, job: Pick<BoxJob, "id" | "owner" | "shopId">, now = new Date()) {
  const until = new Date(now.getTime() + BOX_LEASE_MS);
  const result = await db.execute(sql`
    WITH renewed AS (
      UPDATE box_shop_leases SET lease_until = ${until}
      WHERE shop_id = ${job.shopId}::uuid AND owner = ${job.owner}::uuid AND lease_until > ${now}
      RETURNING shop_id
    ) UPDATE box_jobs j SET lease_until = ${until}
      FROM renewed r WHERE j.id = ${job.id}::uuid AND j.shop_id = r.shop_id AND j.owner = ${job.owner}::uuid
      AND j.status = 'running' AND j.lease_until > ${now} RETURNING j.id
  `);
  return result.rows.length === 1;
}

/** Completion is fenced by both lease and owner, so a resumed stale process cannot overwrite a hold. */
export async function completeBoxJob(db: DB, job: Pick<BoxJob, "id" | "owner" | "shopId">, status: "succeeded" | "failed", summary: string, now = new Date()) {
  const result = await db.execute(sql`
    WITH completed AS (
      UPDATE box_jobs j SET status = ${status}, summary = ${summary.slice(0, 2000)}, finished_at = ${now}, lease_until = NULL
      WHERE j.id = ${job.id}::uuid AND j.owner = ${job.owner}::uuid AND j.status = 'running' AND j.lease_until > ${now}
      AND EXISTS (SELECT 1 FROM box_shop_leases l WHERE l.shop_id = j.shop_id AND l.owner = ${job.owner}::uuid AND l.lease_until > ${now})
      RETURNING j.shop_id
    ) DELETE FROM box_shop_leases l USING completed c
      WHERE l.shop_id = c.shop_id AND l.owner = ${job.owner}::uuid RETURNING l.shop_id
  `);
  return result.rows.length === 1;
}

/** Explicit operator action only, after provider reconciliation; maximum three executions. */
export async function retryHeldBoxJob(db: DB, id: string, shopId: string) {
  const [job] = await db.update(boxJobs).set({ status: "queued", owner: null, leaseUntil: null, finishedAt: null, summary: "Explicit retry requested after reviewing the provider state" })
    .where(and(eq(boxJobs.id, id), eq(boxJobs.shopId, shopId), sql`${boxJobs.status} in ('held','failed')`, sql`${boxJobs.attempts} < ${BOX_MAX_ATTEMPTS}`)).returning();
  return job ?? null;
}

/** Reconciliation can discard uncertain work without another provider call, including at the retry limit. */
export async function resolveHeldBoxJob(db: DB, id: string, shopId: string, now = new Date()) {
  const [job] = await db.update(boxJobs).set({
    status: "failed", finishedAt: now, leaseUntil: null,
    summary: "Operator reconciled provider state and closed this held job without replaying it.",
  }).where(and(eq(boxJobs.id, id), eq(boxJobs.shopId, shopId), eq(boxJobs.status, "held"))).returning();
  if (job) await db.execute(sql`DELETE FROM box_shop_leases WHERE shop_id = ${shopId}::uuid AND owner = ${job.owner}::uuid AND lease_until <= ${now}`);
  return job ?? null;
}

/** Small cron subset used by the dashboard: numbers, stars, steps and comma-separated values. */
function matches(value: number, pattern: string, max: number) {
  return pattern.split(",").some((part) => {
    if (part === "*") return true;
    if (/^\*\/[1-9]\d*$/.test(part)) return value % Number(part.slice(2)) === 0;
    return /^\d+$/.test(part) && Number(part) <= max && Number(part) === value;
  });
}

/** Latest due slot today. Restarting after downtime catches up once, never replays days of paid work. */
export function dueBoxScheduleSlot(expression: string, now = new Date()): Date | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5 || parts.some((p) => !/^(?:\*|\*\/[1-9]\d*|\d+)(?:,(?:\d+))*$/.test(p))) return null;
  const start = new Date(now); start.setUTCHours(0, 0, 0, 0);
  const current = new Date(now); current.setUTCSeconds(0, 0);
  for (let time = current.getTime(); time >= start.getTime(); time -= 60_000) {
    const d = new Date(time);
    const values = [d.getUTCMinutes(), d.getUTCHours(), d.getUTCDate(), d.getUTCMonth() + 1, d.getUTCDay()];
    if (parts.every((p, i) => matches(values[i], p, [59, 23, 31, 12, 7][i]))) return d;
  }
  return null;
}

export async function enqueueDueBoxSchedules(db: DB, shopId: string, settings: StageSettings, now = new Date()) {
  if ((await getSetting(db, "automation")).killSwitch) return [];
  const jobs: BoxJob[] = [];
  const entries = Object.entries(settings) as [StageName, StageSettings[StageName]][];
  const due = entries.filter(([, value]) => !value.paused).map(([stage, value]) => ({ stage, slot: dueBoxScheduleSlot(value.cron, now) }))
    .filter((item): item is { stage: StageName; slot: Date } => Boolean(item.slot)).sort((a, b) => a.slot.getTime() - b.slot.getTime());
  for (const { stage, slot } of due) {
    if (["research", "design", "listing", "daily"].includes(stage) && await stageSucceededToday(db, shopId, stage, now)) continue;
    jobs.push(await enqueueBoxJob(db, { shopId, stage, trigger: "cron", idempotencyKey: `schedule:${stage}:${slot.toISOString()}` }));
  }
  return jobs;
}
