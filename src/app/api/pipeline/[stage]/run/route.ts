import { NextResponse } from "next/server";
import { runFullPipeline, runStage } from "@/pipeline/runner";
import { isStage } from "@/pipeline/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(_req: Request, ctx: { params: Promise<{ stage: string }> }) {
  const { stage } = await ctx.params;
  if (stage === "all") {
    const runs = await runFullPipeline("manual");
    return NextResponse.json({ runs: runs.map((r) => ({ stage: r.stage, status: r.status, summary: r.summary })) });
  }
  if (!isStage(stage)) return NextResponse.json({ error: "unknown stage" }, { status: 404 });
  const run = await runStage(stage, "manual");
  return NextResponse.json({ run: { id: run.id, stage: run.stage, status: run.status, summary: run.summary, logs: run.logs } });
}
