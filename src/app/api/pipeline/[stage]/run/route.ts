import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/session";
import { runFullPipeline, runStage } from "@/pipeline/runner";
import { isStage } from "@/pipeline/types";
import { boxExecutionEnabled, enqueueBoxJob } from "@/lib/box-jobs";
import { getDb } from "@/db";
import { resolveActiveShop } from "@/lib/shops";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request, ctx: { params: Promise<{ stage: string }> }) {
  try {
    await requireAuth();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { stage } = await ctx.params;
  const force = stage === "daily" && new URL(req.url).searchParams.get("force") === "1";
  if (stage !== "all" && !isStage(stage)) return NextResponse.json({ error: "unknown stage" }, { status: 404 });
  if (boxExecutionEnabled()) {
    const db = await getDb();
    const shop = await resolveActiveShop(db);
    const job = await enqueueBoxJob(db, { shopId: shop.id, stage: stage as import("@/db/schema").StageName | "all", trigger: "manual", force });
    return NextResponse.json({ job: { id: job.id, stage: job.stage, status: job.status, summary: "Queued for the local worker" } }, { status: 202 });
  }
  if (stage === "all") {
    const runs = await runFullPipeline("manual");
    return NextResponse.json({ runs: runs.map((r) => ({ stage: r.stage, status: r.status, summary: r.summary })) });
  }
  if (!isStage(stage)) return NextResponse.json({ error: "unknown stage" }, { status: 404 });
  const run = await runStage(stage, "manual", { force });
  return NextResponse.json({ run: { id: run.id, stage: run.stage, status: run.status, summary: run.summary, logs: run.logs } });
}
