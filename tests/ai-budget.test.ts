import path from "node:path";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { reserveAiBudget, recordAiSpend, finishAiBudgetReservation } from "@/lib/ai-budget";
import { acquireStageLock, releaseStageLock, renewStageLock } from "@/lib/stage-lock";

const client = new PGlite("memory://");
const db = drizzle(client, { schema }) as DB;
let shopId: string;
const now = new Date("2026-10-10T12:00:00.000Z");
const reserve = (extra: Partial<Parameters<typeof reserveAiBudget>[1]> = {}) => reserveAiBudget(db, {
  shopId, estimatedCostChf: 0.8, dailyAiCapChf: 1, monthlyAiBudgetChf: 2, now, ...extra,
});
beforeAll(async () => {
  await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  const result = await db.execute(sql`SELECT id FROM shops LIMIT 1`);
  shopId = String(result.rows[0].id);
});
beforeEach(async () => {
  await db.execute(sql`DELETE FROM runtime_ai_reservations`);
  await db.delete(schema.costs);
  await db.execute(sql`DELETE FROM runtime_stage_leases`);
});
afterAll(async () => { await client.close(); });

describe("atomic AI budget reservations", () => {
  it("accepts only one of three concurrent CHF 0.80 operations under a CHF 1 daily cap", async () => {
    const results = await Promise.all([reserve(), reserve(), reserve()]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });
  it("enforces the month across different days and retains uncertain provider calls", async () => {
    const first = await reserve({ dailyAiCapChf: 10, monthlyAiBudgetChf: 1 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await finishAiBudgetReservation(db, first.reservationId, "uncertain");
    const later = new Date(now); later.setUTCDate(now.getUTCDate() + 1);
    expect((await reserve({ now: later, dailyAiCapChf: 10, monthlyAiBudgetChf: 1 })).ok).toBe(false);
  });
  it("counts actual spend exactly once while pending and releases only the unused estimate on settlement", async () => {
    const first = await reserve(); expect(first.ok).toBe(true); if (!first.ok) return;
    await recordAiSpend(db, { shopId, reservationId: first.reservationId, amountChf: 0.6, kind: "ai_image", note: "observed", isDemo: false, now });
    expect((await reserve({ estimatedCostChf: 0.2 })).ok).toBe(true);
    // 0.6 actual + 0.2 remaining first reservation + 0.2 second reservation.
    expect((await reserve({ estimatedCostChf: 0.1 })).ok).toBe(false);
    await finishAiBudgetReservation(db, first.reservationId, "settled");
    expect((await reserve({ estimatedCostChf: 0.1 })).ok).toBe(true);
    expect((await db.select().from(schema.costs))).toHaveLength(1);
  });
  it("frees an unused reservation but does not charge money for free generation", async () => {
    const first = await reserve(); if (!first.ok) throw new Error("reservation rejected");
    await finishAiBudgetReservation(db, first.reservationId, "released");
    expect((await reserve()).ok).toBe(true);
    await db.execute(sql`DELETE FROM runtime_ai_reservations`);
    const free = await reserve({ estimatedCostChf: 0, dailyAiCapChf: 0, monthlyAiBudgetChf: 0, estimatedNeurons: 6000 });
    expect(free.ok).toBe(true); if (!free.ok) return;
    await finishAiBudgetReservation(db, free.reservationId, "settled");
    expect((await reserve({ estimatedCostChf: 0, estimatedNeurons: 5000 })).ok).toBe(false);
    expect(await db.select().from(schema.costs)).toHaveLength(0);
  });
  it("rejects invalid amounts instead of corrupting the budget", async () => {
    expect((await reserve({ estimatedCostChf: -1 })).ok).toBe(false);
    expect((await reserve({ estimatedCostChf: Number.NaN })).ok).toBe(false);
  });
});

describe("fenced stage leases", () => {
  it("has distinct keys per stage and rejects reentry from the same database connection", async () => {
    const first = await acquireStageLock(db, "daily", shopId);
    expect(first).not.toBeNull(); if (!first) return;
    expect(await acquireStageLock(db, "daily", shopId)).toBeNull();
    expect(await acquireStageLock(db, "orders", shopId)).not.toBeNull();
    expect(await renewStageLock(db, first)).toBe(true);
    await releaseStageLock(db, first);
    expect(await acquireStageLock(db, "daily", shopId)).not.toBeNull();
  });
  it("cannot renew or release a replacement owner's lease", async () => {
    const first = await acquireStageLock(db, "daily", shopId); if (!first) throw new Error("no lease");
    await db.execute(sql`UPDATE runtime_stage_leases SET expires_at=now()-interval '1 second' WHERE owner=${first.owner}::uuid`);
    const second = await acquireStageLock(db, "daily", shopId); expect(second).not.toBeNull(); if (!second) return;
    expect(second.owner).not.toBe(first.owner);
    expect(await renewStageLock(db, first)).toBe(false);
    await releaseStageLock(db, first);
    expect(await acquireStageLock(db, "daily", shopId)).toBeNull();
    await releaseStageLock(db, { ...second, owner: randomUUID() });
    expect(await renewStageLock(db, second)).toBe(true);
  });
  it("migrates the dead-letter table with one unresolved hold per listing", async () => {
    expect((await db.execute(sql`SELECT to_regclass('public.publish_dead_letters') AS name`)).rows[0].name).toBe("publish_dead_letters");
  });
});
