import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { authorizedUpscaleJob } from "@/lib/upscale-jobs";
import { reviewQueue } from "@/lib/review-queue";

export const dynamic = "force-dynamic";

/** Read-only review/approval queue audit, behind CRON_SECRET. Changes nothing. */
export async function GET(req: Request) {
  // CRON_SECRET, or the box worker's UPSCALER_SECRET (read-only audit from the box).
  if (!authorizedUpscaleJob(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const items = await reviewQueue(await getDb());
  return NextResponse.json({ count: items.length, items });
}
