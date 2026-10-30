import { config as loadEnv } from "dotenv";
loadEnv({ path: [".env.box", ".env.local", ".env"], quiet: true });

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import { getDb, type DB } from "@/db";
import { shops } from "@/db/schema";
import { type BoxJob } from "@/db/box-jobs";
import { claimBoxJob, completeBoxJob, enqueueBoxJob, enqueueDueBoxSchedules, heartbeatBoxJob, boxExecutionEnabled } from "@/lib/box-jobs";
import { executeSession } from "@/lib/brain/sessions";
import { getSetting } from "@/lib/settings";
import { resolveActiveShop } from "@/lib/shops";
import { isStage } from "@/pipeline/types";
import { maskSecrets } from "@/pipeline/stage-log";

export const MIN_BOX_IDLE_POLL_MS = 15 * 60_000;
export function boxIdlePollMs(input = process.env.BOX_IDLE_POLL_MS) {
  const requested = Number(input ?? MIN_BOX_IDLE_POLL_MS);
  return Number.isFinite(requested) ? Math.max(MIN_BOX_IDLE_POLL_MS, requested) : MIN_BOX_IDLE_POLL_MS;
}

/** Heartbeats are only active during work. Idle polling allows a free Neon database to sleep. */
export async function executeBoxJob(db: DB, job: BoxJob): Promise<"succeeded" | "failed" | "held"> {
  const abort = new AbortController();
  let renewing = false;
  let leaseLost = false;
  const heartbeat = setInterval(async () => {
    if (renewing) return;
    renewing = true;
    try {
      if (!(await heartbeatBoxJob(db, job))) { leaseLost = true; abort.abort(); }
    } catch { leaseLost = true; abort.abort(); }
    finally { renewing = false; }
  }, 60_000);
  try {
    const { runStage, runFullPipeline } = await import("@/pipeline/runner");
    const opts = { db, force: job.force, signal: abort.signal, shopId: job.shopId };
    if (job.trigger === "cron" && !job.force && ["research", "design", "listing", "daily"].includes(job.stage)) {
      const { stageSucceededToday } = await import("@/pipeline/chain-day");
      if (job.stage !== "all" && await stageSucceededToday(db, job.shopId, job.stage, new Date())) {
        return await completeBoxJob(db, job, "succeeded", "Already completed today; duplicate scheduled work skipped") ? "succeeded" : "held";
      }
    }
    const result = job.sessionId
      ? await executeSession(db, job.sessionId, (stage, sessionSignal) => runStage(stage, "manual", { ...opts, signal: AbortSignal.any([abort.signal, sessionSignal]) }))
      : job.stage === "all"
        ? await runFullPipeline(job.trigger, opts)
        : await runStage(job.stage, job.trigger, opts);
    const results = Array.isArray(result) ? result : result ? [result] : [];
    const failed = !results.length || results.some((run) => ["failed", "cancelled"].includes(run.status));
    const summary = results.map((run) => `${"stage" in run ? run.stage : job.stage}: ${run.summary ?? run.status}`).join(" · ") || "Session no longer exists";
    if (leaseLost) return "held";
    const status = failed ? "failed" : "succeeded";
    return await completeBoxJob(db, job, status, maskSecrets(summary)) ? status : "held";
  } catch (error) {
    if (leaseLost) return "held";
    return await completeBoxJob(db, job, "failed", maskSecrets(error instanceof Error ? error.message : "Box job failed")) ? "failed" : "held";
  } finally {
    clearInterval(heartbeat);
  }
}

/** Returns after a bounded amount of work, also usable with launchd/systemd or Task Scheduler. */
export async function runBoxOnce(opts: { stage?: string; schedule?: boolean; limit?: number } = {}) {
  if (!boxExecutionEnabled()) throw new Error("Set AUTOPILOT_EXECUTION=box before starting the box worker");
  if (process.env.UPSCALER_URL?.trim()) throw new Error("Remove UPSCALER_URL from the box environment: remote upscale workers are disabled in box mode");
  process.env.AUTOPILOT_BOX_WORKER = "1";
  process.env.UPSCALER_ROLE = "worker";
  process.env.UPSCALER_PULL = "off";
  const db = await getDb();
  const requested = process.env.BOX_SHOP_ID;
  const shop = await resolveActiveShop(db, requested);
  if (requested && shop.id !== requested) throw new Error("BOX_SHOP_ID is not registered");
  const [fresh] = await db.select().from(shops).where(eq(shops.id, shop.id));
  if (fresh.killSwitch || (await getSetting(db, "automation")).killSwitch) {
    console.log("[box] Automation is paused by a kill switch");
    return 0;
  }
  if (opts.stage) {
    if (opts.stage !== "all" && !isStage(opts.stage)) throw new Error("Unknown stage for --stage");
    await enqueueBoxJob(db, { shopId: shop.id, stage: opts.stage, trigger: "manual" });
  } else if (opts.schedule !== false) {
    await enqueueDueBoxSchedules(db, shop.id, await getSetting(db, "stages"));
  }
  let completed = 0;
  let failed = 0;
  const limit = Math.min(25, Math.max(1, opts.limit ?? 10));
  for (let i = 0; i < limit; i++) {
    const job = await claimBoxJob(db, randomUUID(), new Date(), shop.id);
    if (!job) break;
    console.log(`[box] Starting ${job.stage}, job ${job.id}`);
    const status = await executeBoxJob(db, job);
    if (status !== "succeeded") failed++;
    console.log(`[box] ${job.stage}, job ${job.id}: ${status}`);
    completed++;
  }
  console.log(`[box] Finished ${completed} job(s)`);
  if (failed) throw new Error(`${failed} box job(s) failed or lost their lease; inspect Jobs before retrying`);
  if (opts.stage && completed === 0) throw new Error("Requested stage is queued but blocked by active or held work; inspect Jobs");
  return completed;
}

async function main() {
  const args = process.argv.slice(2);
  const stageIndex = args.indexOf("--stage");
  if (stageIndex >= 0 && !args[stageIndex + 1]) throw new Error("--stage requires a stage name");
  const stage = stageIndex >= 0 ? args[stageIndex + 1] : undefined;
  if (args.includes("--once") || stage) { await runBoxOnce({ stage }); return; }
  console.log(`[box] Running; idle polling every ${boxIdlePollMs() / 60_000} minutes`);
  for (;;) {
    try { await runBoxOnce(); }
    catch (error) { console.error(`[box] ${maskSecrets(error instanceof Error ? error.message : "Worker iteration failed")}`); }
    await new Promise((resolve) => setTimeout(resolve, boxIdlePollMs()));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[box] ${maskSecrets(error instanceof Error ? error.message : "Worker failed")}`);
    process.exitCode = 1;
  });
}
