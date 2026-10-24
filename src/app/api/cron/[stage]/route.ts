import { after, NextResponse } from "next/server";
import { getDb } from "@/db";
import { resolveActiveShop } from "@/lib/shops";
import { enqueueJob, drainJobs } from "@/lib/durable-jobs";
import { randomUUID } from "node:crypto";
import { config } from "@/lib/config";
import { parseMaintenanceSummary } from "@/pipeline/maintenance";
import { runStage } from "@/pipeline/runner";
import { isStage } from "@/pipeline/types";

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
  if (stage === "daily" || stage === "orders") {
    const db=await getDb();
    const shop=await resolveActiveShop(db);
    const requestKey=req.headers.get("idempotency-key") ?? (force ? randomUUID() : new Date().toISOString().slice(0,10));
    const job=await enqueueJob(db,shop.id,"stage",`stage:${shop.id}:${stage}:${requestKey}`,{stage,force});
    after(async()=>{ await drainJobs(db,1); });
    return NextResponse.json({stage,status:"accepted",jobId:job.id,jobStatus:job.status},{status:202});
  }
  const run = await runStage(stage, "cron", { force });
  const summary = stage === "maintenance" ? parseMaintenanceSummary(run.summary) : run.summary;
  return NextResponse.json({ stage, status: run.status, summary }, { status: run.status === "failed" ? 500 : 200 });
}
