import { after, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { boxExecutionEnabled, enqueueBoxJob, dueBoxScheduleSlot } from "@/lib/box-jobs";
import { getDb } from "@/db";
import { getSetting } from "@/lib/settings";
import { resolveActiveShop } from "@/lib/shops";
import { parseMaintenanceSummary } from "@/pipeline/maintenance";
import { runStage } from "@/pipeline/runner";
import { isStage } from "@/pipeline/types";
import { writeStageLog } from "@/pipeline/stage-log";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Called by GitHub Actions cron with `Authorization: Bearer $CRON_SECRET`.
 * `daily` runs research → design brief → listing draft and leaves drafts pending.
 * `health` runs the Monday report. Neither route publishes or changes go-live.
 * `hot` scans observed demand and merges keywords; it never estimates sales.
 * `?force=1` reruns the daily chain after a success already recorded today.
 * Daily/orders return 202; progress and failures are recorded in the activity log.
 * Other failed stages return HTTP 500 so the workflow goes red.
 */
export async function GET(req: Request, ctx: { params: Promise<{ stage: string }> }) {
  const secret = config.cronSecret;
  const auth = req.headers.get("authorization");
  if (secret ? auth !== `Bearer ${secret}` : process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { stage } = await ctx.params;
  if (!isStage(stage)) return NextResponse.json({ error: "unknown stage" }, { status: 404 });
  const force = new URL(req.url).searchParams.get("force") === "1";
  if (boxExecutionEnabled()) {
    const db = await getDb();
    const shop = await resolveActiveShop(db);
    const stages = await getSetting(db, "stages");
    const now = new Date();
    const slot = dueBoxScheduleSlot(stages[stage]?.cron ?? "", now);
    const idempotencyKey = !force && slot ? `schedule:${stage}:${slot.toISOString()}` : undefined;
    const job = await enqueueBoxJob(db, { shopId: shop.id, stage, trigger: "cron", force, idempotencyKey });
    return NextResponse.json({ stage, status: job.status, jobId: job.id }, { status: 202 });
  }
  if (stage === "daily" || stage === "orders") {
    after(async () => {
      try {
        await runStage(stage, "cron", { force });
      } catch (error) {
        writeStageLog(stage, "error", error instanceof Error ? error.message : "Background run failed");
      }
    });
    return NextResponse.json({ stage, status: "accepted" }, { status: 202 });
  }
  const run = await runStage(stage, "cron", { force });
  const summary = stage === "maintenance" ? parseMaintenanceSummary(run.summary) : run.summary;
  return NextResponse.json({ stage, status: run.status, summary }, { status: run.status === "failed" ? 500 : 200 });
}
