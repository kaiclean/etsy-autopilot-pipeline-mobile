import { and, eq } from "drizzle-orm";
import { after, NextResponse } from "next/server";
import { getDb } from "@/db";
import { jobRuns } from "@/db/schema";
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
 * A failed stage returns this same JSON with HTTP 500 so the workflow goes red.
 */
export async function GET(req: Request, ctx: { params: Promise<{ stage: string }> }) {
  const secret = config.cronSecret;
  const auth = req.headers.get("authorization");
  if (secret ? auth !== `Bearer ${secret}` : process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { stage } = await ctx.params;
  if (!isStage(stage)) return NextResponse.json({ error: "unknown stage" }, { status: 404 });
  const search = new URL(req.url).searchParams;
  if (search.has("runId")) {
    const id = Number(search.get("runId"));
    if (!Number.isSafeInteger(id) || id <= 0) {
      return NextResponse.json({ error: "invalid run id" }, { status: 400 });
    }
    const db = await getDb();
    const [run] = await db.select().from(jobRuns).where(and(eq(jobRuns.id, id), eq(jobRuns.stage, stage)));
    if (!run) return NextResponse.json({ error: "unknown run" }, { status: 404 });
    const summary = stage === "maintenance" ? parseMaintenanceSummary(run.summary) : run.summary;
    return NextResponse.json({ id: run.id, stage, status: run.status, summary }, {
      status: run.status === "failed" ? 500 : run.status === "running" ? 202 : 200,
    });
  }
  if (stage === "daily" && search.get("async") === "1") {
    const run = await runStage(stage, "cron", {
      force: search.get("force") === "1",
      defer: (execute) => after(async () => { await execute(); }),
    });
    return NextResponse.json({ id: run.id, stage, status: run.status, summary: run.summary }, {
      status: run.status === "failed" ? 500 : run.status === "running" ? 202 : 200,
    });
  }
  const force = new URL(req.url).searchParams.get("force") === "1";
  const run = await runStage(stage, "cron", { force });
  const summary = stage === "maintenance" ? parseMaintenanceSummary(run.summary) : run.summary;
  return NextResponse.json({ stage, status: run.status, summary }, { status: run.status === "failed" ? 500 : 200 });
}
