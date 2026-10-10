import { and, eq, gte } from "drizzle-orm";
import { getDb, type DB } from "@/db";
import { jobRuns, type JobRun, type LogLine, type StageName } from "@/db/schema";
import { isDemoMode } from "@/lib/config";
import { emit } from "@/lib/events";
import { formatMaintenanceSummary } from "@/lib/maintenance-summary";
import { isProviderCreditsError } from "@/lib/provider-errors";
import { utcDayKey } from "@/lib/utc-day";
import { getSetting, setSetting } from "@/lib/settings";
import { resolveActiveShop } from "@/lib/shops";
import { runAnalytics } from "./analytics";
import { stageSucceededToday } from "./chain-day";
import { runDesign } from "./design";
import { publishHealthReport } from "./health-report";
import { runListing } from "./listing";
import { runMaintenance } from "./maintenance";
import { runOrders } from "./orders";
import { runPublish } from "./publish";
import { runResearch } from "./research";
import { writeStageLog } from "./stage-log";
import { STAGES, asStageResult, stageResult, type StageContext, type StageFn, type StageStatus } from "./types";

const CHAIN_STAGES = ["research", "design", "listing"] as const;

/** Research, then a design brief, then a listing draft. Never publishes or arms go-live. */
async function runDailyChain(ctx: StageContext) {
  if (!ctx.force && (await stageSucceededToday(ctx.db, ctx.shopId, "daily", ctx.now))) {
    return `Daily chain already completed for ${utcDayKey(ctx.now)}. Drafts stay pending approval. Publish mode was not changed.`;
  }
  const before = await getSetting(ctx.db, "automation");
  const stageSettings = await getSetting(ctx.db, "stages");
  const parts: string[] = [];
  let warned = false;
  for (const stage of CHAIN_STAGES) {
    if (stageSettings[stage]?.paused) {
      parts.push(`${stage}: paused`);
      ctx.log(`${stage} is paused; daily chain skipped it`);
      continue;
    }
    if (!ctx.force && (await stageSucceededToday(ctx.db, ctx.shopId, stage, ctx.now))) {
      parts.push(`${stage}: already completed today`);
      ctx.log(`${stage} already completed today`);
      continue;
    }
    const run = await runStage(stage, "chain", { db: ctx.db, random: ctx.random, now: ctx.now, force: ctx.force });
    parts.push(`${stage}: ${run.summary ?? run.status}`);
    ctx.log(`${stage} ${run.status}: ${run.summary ?? ""}`);
    if (run.status === "failed") throw new Error(run.summary ?? `${stage} failed`);
    if (run.status === "warning") warned = true;
  }
  const after = await getSetting(ctx.db, "automation");
  if (after.publishMode !== before.publishMode) {
    await setSetting(ctx.db, "automation", { ...after, publishMode: before.publishMode });
    ctx.log("Restored publish mode. The daily chain does not change go-live.", "warn");
  }
  const summary = `Daily chain finished (${parts.join(" · ")}). New drafts are pending approval or held by the quality gate. Nothing was activated.`;
  if (warned) return stageResult(summary, "warning");
  return summary;
}

const runHealth: StageFn = async (ctx) => {
  const { payload, pushed } = await publishHealthReport(ctx.db, ctx.shopId, ctx.now);
  ctx.log(
    `Week ${payload.weekStart}: ${payload.views} views, ${payload.favorites} favorites, ${payload.sales} sales, profit CHF ${payload.profitChf.toFixed(2)}, VAT CHF ${payload.vatChf.toFixed(2)}, POD CHF ${payload.podCostChf.toFixed(2)}, ad estimate CHF ${payload.adsEstimateChf.toFixed(2)}, actual ads CHF ${payload.adsActualChf.toFixed(2)}, ${payload.suggestions.length} suggestions`,
  );
  const note = pushed ? "push sent" : "report updated, push already sent";
  return `Week of ${payload.weekStart}: ${payload.views} views, ${payload.favorites} favorites, ${payload.sales} sales, profit CHF ${payload.profitChf.toFixed(2)} (${note})`;
};

const STAGE_FNS: Record<StageName, StageFn> = {
  research: runResearch,
  design: runDesign,
  listing: runListing,
  publish: runPublish,
  orders: runOrders,
  analytics: runAnalytics,
  maintenance: runMaintenance,
  daily: runDailyChain,
  health: runHealth,
};

export type RunOptions = { db?: DB; random?: () => number; now?: Date; force?: boolean };

async function recordSkip(db: DB, stage: StageName, trigger: StageContext["trigger"], summary: string, shopId: string, demo: boolean) {
  const [run] = await db
    .insert(jobRuns)
    .values({ shopId, stage, status: "skipped", trigger, summary, finishedAt: new Date(), isDemo: demo })
    .returning();
  return run;
}

export async function runStage(stage: StageName, trigger: StageContext["trigger"], opts: RunOptions = {}): Promise<JobRun> {
  const db = opts.db ?? (await getDb());
  const shop = await resolveActiveShop(db);
  const demo = isDemoMode(shop.etsyShopId ?? undefined);
  const automation = await getSetting(db, "automation");
  // Global settings.killSwitch pauses every shop. shops.kill_switch pauses this shop only.
  if (automation.killSwitch || shop.killSwitch) {
    const summary = automation.killSwitch ? "Kill switch is on: all automation paused" : "Shop kill switch is on: this shop is paused";
    return recordSkip(db, stage, trigger, summary, shop.id, demo);
  }

  const stages = await getSetting(db, "stages");
  if (stages[stage]?.paused && trigger === "cron") return recordSkip(db, stage, trigger, "Stage paused", shop.id, demo);

  const [running] = await db
    .select({ id: jobRuns.id })
    .from(jobRuns)
    .where(and(eq(jobRuns.stage, stage), eq(jobRuns.status, "running"), gte(jobRuns.startedAt, new Date(Date.now() - 5 * 60_000))));
  if (running) return recordSkip(db, stage, trigger, "Already running", shop.id, demo);

  const [run] = await db.insert(jobRuns).values({ shopId: shop.id, stage, status: "running", trigger, isDemo: demo }).returning();
  const logs: LogLine[] = [];
  const ctx: StageContext = {
    db,
    shopId: shop.id,
    demo,
    trigger,
    random: opts.random ?? Math.random,
    now: opts.now ?? new Date(),
    force: opts.force === true,
    log: (msg, level = "info") => {
      const safe = writeStageLog(stage, level, msg);
      logs.push({ t: new Date().toISOString(), level, msg: safe });
    },
  };
  const label = STAGES.find((s) => s.id === stage)!.label;
  const afterOrders = async () => {
    if (stage !== "orders" || trigger !== "cron") return;
    try {
      const maintenance = await runStage("maintenance", "cron", opts);
      ctx.log(`maintenance ${maintenance.status}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "maintenance failed";
      ctx.log(`maintenance failed: ${message.slice(0, 200)}`, "error");
    }
  };
  try {
    const result = asStageResult(await STAGE_FNS[stage](ctx));
    await afterOrders();
    const [done] = await db
      .update(jobRuns)
      .set({ status: result.status, summary: result.summary, logs, finishedAt: new Date() })
      .where(eq(jobRuns.id, run.id))
      .returning();
    await emitStageOutcome(db, demo, trigger, label, result.status, formatMaintenanceSummary(result.summary));
    return done;
  } catch (e) {
    const msg = writeStageLog(stage, "error", (e as Error).message);
    logs.push({ t: new Date().toISOString(), level: "error", msg });
    await afterOrders();
    const [done] = await db
      .update(jobRuns)
      .set({ status: "failed", summary: msg, logs, finishedAt: new Date() })
      .where(eq(jobRuns.id, run.id))
      .returning();
    await emitStageOutcome(db, demo, trigger, label, "failed", msg);
    return done;
  }
}

/** One credits push per run. A nested chain stage stays quiet so the cron parent is the push. */
async function emitStageOutcome(
  db: DB,
  demo: boolean,
  trigger: StageContext["trigger"],
  label: string,
  status: StageStatus,
  summary: string,
) {
  if (isProviderCreditsError(summary)) {
    await emit(
      db,
      { type: "job.failed", title: "Image provider out of credits", body: summary, severity: "error", href: "/pipeline/live" },
      demo,
      trigger === "chain" ? { push: false } : undefined,
    );
    return;
  }
  if (status === "failed") {
    await emit(db, { type: "job.failed", title: `${label} failed`, body: summary, severity: "error", href: "/pipeline" }, demo);
    return;
  }
  if (status === "warning") {
    await emit(
      db,
      { type: "job.warning", title: `${label} finished with warnings`, body: summary, severity: "warning", href: "/pipeline/live" },
      demo,
      { push: false },
    );
    return;
  }
  await emit(db, { type: "job.success", title: `${label} finished`, body: summary, severity: "info", href: "/pipeline" }, demo);
}

const ORCHESTRATORS = new Set<StageName>(["daily", "health"]);

/** Runs every production stage in order. The daily chain and Monday report stay on their own crons. */
export async function runFullPipeline(trigger: StageContext["trigger"] = "manual", opts: RunOptions = {}) {
  const results: JobRun[] = [];
  for (const s of STAGES) {
    if (ORCHESTRATORS.has(s.id)) continue;
    const r = await runStage(s.id, trigger === "manual" ? "chain" : trigger, opts);
    results.push(r);
    if (r.status === "skipped" && r.summary?.startsWith("Kill switch")) break;
  }
  return results;
}
