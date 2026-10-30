import { randomUUID } from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import { shops } from "@/db/schema";
import { boxJobs } from "@/db/box-jobs";
import { BOX_LEASE_MS, claimBoxJob, completeBoxJob, dueBoxScheduleSlot, enqueueBoxJob, heartbeatBoxJob, holdExpiredBoxJobs, retryHeldBoxJob, resolveHeldBoxJob } from "@/lib/box-jobs";
import { boxIdlePollMs, executeBoxJob, runBoxOnce } from "../workers/box/worker";

const workerMocks = vi.hoisted(() => ({ getDb: vi.fn(), runStage: vi.fn(), runFullPipeline: vi.fn() }));
vi.mock("@/db", () => ({ getDb: workerMocks.getDb }));
vi.mock("@/pipeline/runner", () => ({ runStage: workerMocks.runStage, runFullPipeline: workerMocks.runFullPipeline }));

describe("durable outbound-only box queue", () => {
  const client = new PGlite("memory://");
  const db = drizzle(client) as unknown as DB;
  let shopId: string;
  const now = new Date("2026-10-30T09:00:00Z");
  beforeAll(async () => {
    await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
    // Also supports the isolated test while the new migration is being journaled.
    const migration = await readFile(path.join(process.cwd(), "drizzle/0032_box_jobs.sql"), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) await client.exec(statement);
    const [shop] = await db.select().from(shops).limit(1); shopId = shop.id;
  });
  beforeEach(async () => {
    await client.exec("DELETE FROM box_shop_leases; DELETE FROM box_jobs;");
    workerMocks.getDb.mockReset().mockResolvedValue(db);
    workerMocks.runStage.mockReset();
    workerMocks.runFullPipeline.mockReset();
  });
  afterEach(() => { vi.unstubAllEnvs(); });
  afterAll(async () => { await client.close(); });

  it("deduplicates a scheduled delivery and rejects changed intent", async () => {
    const opts = { shopId, stage: "daily" as const, trigger: "cron" as const, idempotencyKey: "daily:2026-10-30" };
    const jobs = await Promise.all([enqueueBoxJob(db, opts), enqueueBoxJob(db, opts)]);
    expect(jobs[0].id).toBe(jobs[1].id);
    await expect(enqueueBoxJob(db, { ...opts, force: true })).rejects.toThrow("different job");
  });

  it("allows only one same-shop claim despite simultaneous claimers and multiple queued jobs", async () => {
    await enqueueBoxJob(db, { shopId, stage: "daily", trigger: "manual" });
    await enqueueBoxJob(db, { shopId, stage: "orders", trigger: "manual" });
    const claims = await Promise.all([claimBoxJob(db, randomUUID(), now), claimBoxJob(db, randomUUID(), now)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const winner = claims.find(Boolean)!;
    expect(winner.status).toBe("running");
    expect(await completeBoxJob(db, winner, "succeeded", "done", now)).toBe(true);
    expect(await claimBoxJob(db, randomUUID(), now)).not.toBeNull();
  });

  it("heartbeats renew a lease; a different owner cannot complete or release it", async () => {
    await enqueueBoxJob(db, { shopId, stage: "orders", trigger: "manual" });
    const claimed = (await claimBoxJob(db, randomUUID(), now))!;
    const later = new Date(now.getTime() + BOX_LEASE_MS - 1000);
    expect(await heartbeatBoxJob(db, claimed, later)).toBe(true);
    expect(await completeBoxJob(db, { ...claimed, owner: randomUUID() }, "succeeded", "forged", later)).toBe(false);
    expect(await claimBoxJob(db, randomUUID(), new Date(now.getTime() + BOX_LEASE_MS + 1000))).toBeNull();
    expect(await completeBoxJob(db, claimed, "succeeded", "done", later)).toBe(true);
  });

  it("holds expired work and fences stale completion across a restart", async () => {
    const job = await enqueueBoxJob(db, { shopId, stage: "publish", trigger: "manual" });
    const claimed = (await claimBoxJob(db, randomUUID(), now))!;
    await enqueueBoxJob(db, { shopId, stage: "daily", trigger: "manual" });
    const expired = new Date(now.getTime() + BOX_LEASE_MS + 1);
    expect(await holdExpiredBoxJobs(db, expired)).toEqual([{ id: job.id }]);
    expect(await completeBoxJob(db, claimed, "succeeded", "late", expired)).toBe(false);
    expect(await heartbeatBoxJob(db, claimed, expired)).toBe(false);
    expect(await claimBoxJob(db, randomUUID(), expired)).toBeNull();
    const [held] = await db.select().from(boxJobs).where(eq(boxJobs.id, job.id));
    expect(held.status).toBe("held");
    const replay = await retryHeldBoxJob(db, job.id, shopId);
    expect(replay?.status).toBe("queued");
    expect(await claimBoxJob(db, randomUUID(), expired)).not.toBeNull();
  });

  it("does not automatically retry failures and bounds explicit retries", async () => {
    const job = await enqueueBoxJob(db, { shopId, stage: "publish", trigger: "manual" });
    for (let attempt = 1; attempt <= 3; attempt++) {
      const claimed = (await claimBoxJob(db, randomUUID(), now))!;
      expect(claimed.attempts).toBe(attempt);
      expect(await completeBoxJob(db, claimed, "failed", "provider refused", now)).toBe(true);
      expect(await claimBoxJob(db, randomUUID(), now)).toBeNull();
      const retry = await retryHeldBoxJob(db, job.id, shopId);
      expect(retry?.status ?? null).toBe(attempt < 3 ? "queued" : null);
    }
  });

  it("never lets a different shop reset another shop's job", async () => {
    const job = await enqueueBoxJob(db, { shopId, stage: "orders", trigger: "manual" });
    const claimed = (await claimBoxJob(db, randomUUID(), now))!;
    await completeBoxJob(db, claimed, "failed", "done", now);
    expect(await retryHeldBoxJob(db, job.id, randomUUID())).toBeNull();
  });

  it("lets an operator reconcile exhausted held work without replaying it or blocking later jobs", async () => {
    const job = await enqueueBoxJob(db, { shopId, stage: "publish", trigger: "manual" });
    await db.update(boxJobs).set({ attempts: 2 }).where(eq(boxJobs.id, job.id));
    const claimed = (await claimBoxJob(db, randomUUID(), now))!;
    const expired = new Date(now.getTime() + BOX_LEASE_MS + 1);
    await holdExpiredBoxJobs(db, expired);
    expect(await retryHeldBoxJob(db, job.id, shopId)).toBeNull();
    expect(await resolveHeldBoxJob(db, job.id, randomUUID(), expired)).toBeNull();
    expect((await resolveHeldBoxJob(db, job.id, shopId, expired))?.status).toBe("failed");
    expect(await completeBoxJob(db, claimed, "succeeded", "late result", expired)).toBe(false);
    await enqueueBoxJob(db, { shopId, stage: "orders", trigger: "manual" });
    expect((await claimBoxJob(db, randomUUID(), expired))?.stage).toBe("orders");
  });

  it("catches up only today's latest UTC slot and validates schedule syntax", () => {
    expect(dueBoxScheduleSlot("20 5 * * *", now)?.toISOString()).toBe("2026-10-30T05:20:00.000Z");
    expect(dueBoxScheduleSlot("0 5 * * 1", now)).toBeNull();
    expect(dueBoxScheduleSlot("*/30 * * * *", now)?.toISOString()).toBe("2026-10-30T09:00:00.000Z");
    expect(dueBoxScheduleSlot("0 18 * * *", now)).toBeNull();
    expect(dueBoxScheduleSlot("malformed", now)).toBeNull();
  });

  it("persists a failed stage instead of treating accepted execution as success", async () => {
    workerMocks.runStage.mockResolvedValue({ id: 1, stage: "publish", status: "failed", summary: "Provider refused" });
    await enqueueBoxJob(db, { shopId, stage: "publish", trigger: "manual" });
    const claimed = (await claimBoxJob(db, randomUUID()))!;
    expect(await executeBoxJob(db, claimed)).toBe("failed");
    const [finished] = await db.select().from(boxJobs).where(eq(boxJobs.id, claimed.id));
    expect(finished.status).toBe("failed");
    expect(workerMocks.runStage).toHaveBeenCalledWith("publish", "manual", expect.objectContaining({ shopId }));
  });

  it("makes --stage/--once fail visibly when work fails and rejects remote upscale URLs", async () => {
    vi.stubEnv("AUTOPILOT_EXECUTION", "box");
    vi.stubEnv("UPSCALER_URL", "");
    workerMocks.runStage.mockResolvedValue({ id: 1, stage: "orders", status: "failed", summary: "Sync failed" });
    await expect(runBoxOnce({ stage: "orders", schedule: false })).rejects.toThrow("failed or lost their lease");
    vi.stubEnv("UPSCALER_URL", "https://paid-worker.example");
    await expect(runBoxOnce({ schedule: false })).rejects.toThrow("remote upscale workers are disabled");
    expect(boxIdlePollMs("1000")).toBe(900_000);
  });
});
