import { and, eq, gte } from "drizzle-orm";
import { getDb, type DB } from "@/db";
import { jobRuns, type JobRun, type LogLine, type StageName } from "@/db/schema";
import { isDemoMode } from "@/lib/config";
import { emit } from "@/lib/events";
import { getSetting } from "@/lib/settings";
import { runAnalytics } from "./analytics";
import { runDesign } from "./design";
import { runListing } from "./listing";
import { runOrders } from "./orders";
import { runPublish } from "./publish";
import { runResearch } from "./research";
import { STAGES, type StageContext, type StageFn } from "./types";

const STAGE_FNS: Record<StageName, StageFn> = {
  research: runResearch,
  design: runDesign,
  listing: runListing,
  publish: runPublish,
  orders: runOrders,
  analytics: runAnalytics,
};

export type RunOptions = { db?: DB; random?: () => number; now?: Date };

async function recordSkip(db: DB, stage: StageName, trigger: StageContext["trigger"], summary: string) {
  const [run] = await db
    .insert(jobRuns)
    .values({ stage, status: "skipped", trigger, summary, finishedAt: new Date(), isDemo: isDemoMode() })
    .returning();
  return run;
}

export async function runStage(stage: StageName, trigger: StageContext["trigger"], opts: RunOptions = {}): Promise<JobRun> {
  const db = opts.db ?? (await getDb());
  const automation = await getSetting(db, "automation");
  if (automation.killSwitch) return recordSkip(db, stage, trigger, "Kill switch is on: all automation paused");

  const stages = await getSetting(db, "stages");
  if (stages[stage]?.paused && trigger === "cron") return recordSkip(db, stage, trigger, "Stage paused");

  const [running] = await db
    .select({ id: jobRuns.id })
    .from(jobRuns)
    .where(and(eq(jobRuns.stage, stage), eq(jobRuns.status, "running"), gte(jobRuns.startedAt, new Date(Date.now() - 5 * 60_000))));
  if (running) return recordSkip(db, stage, trigger, "Already running");

  const [run] = await db.insert(jobRuns).values({ stage, status: "running", trigger, isDemo: isDemoMode() }).returning();
  const logs: LogLine[] = [];
  const ctx: StageContext = {
    db,
    trigger,
    random: opts.random ?? Math.random,
    now: opts.now ?? new Date(),
    log: (msg, level = "info") => logs.push({ t: new Date().toISOString(), level, msg }),
  };
  const label = STAGES.find((s) => s.id === stage)!.label;
  try {
    const summary = await STAGE_FNS[stage](ctx);
    const [done] = await db
      .update(jobRuns)
      .set({ status: "success", summary, logs, finishedAt: new Date() })
      .where(eq(jobRuns.id, run.id))
      .returning();
    await emit(db, { type: "job.success", title: `${label} finished`, body: summary, severity: "info", href: "/pipeline" });
    return done;
  } catch (e) {
    const msg = (e as Error).message;
    logs.push({ t: new Date().toISOString(), level: "error", msg });
    const [done] = await db
      .update(jobRuns)
      .set({ status: "failed", summary: msg, logs, finishedAt: new Date() })
      .where(eq(jobRuns.id, run.id))
      .returning();
    await emit(db, { type: "job.failed", title: `${label} failed`, body: msg, severity: "error", href: "/pipeline" });
    return done;
  }
}

/** Runs every stage in order. Publishing only touches listings Kai already approved. */
export async function runFullPipeline(trigger: StageContext["trigger"] = "manual", opts: RunOptions = {}) {
  const results: JobRun[] = [];
  for (const s of STAGES) {
    const r = await runStage(s.id, trigger === "manual" ? "chain" : trigger, opts);
    results.push(r);
    if (r.status === "skipped" && r.summary?.startsWith("Kill switch")) break;
  }
  return results;
}
