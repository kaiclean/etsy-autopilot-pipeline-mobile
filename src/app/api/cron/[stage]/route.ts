import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { runStage } from "@/pipeline/runner";
import { isStage } from "@/pipeline/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Called by Vercel Cron, which sends `Authorization: Bearer $CRON_SECRET`. */
export async function GET(req: Request, ctx: { params: Promise<{ stage: string }> }) {
  const secret = config.cronSecret;
  const auth = req.headers.get("authorization");
  if (secret ? auth !== `Bearer ${secret}` : process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { stage } = await ctx.params;
  if (!isStage(stage)) return NextResponse.json({ error: "unknown stage" }, { status: 404 });
  const run = await runStage(stage, "cron");
  return NextResponse.json({ stage, status: run.status, summary: run.summary });
}
