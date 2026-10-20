import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { authorizedUpscaleJob, redesignQueue } from "@/lib/upscale-jobs";

export const dynamic = "force-dynamic";

/** Read-only list for Design: designs flagged for a full-size rebuild, with their original prompt and target. */
export async function GET(req: Request) {
  if (!authorizedUpscaleJob(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const items = await redesignQueue(await getDb());
  return NextResponse.json({ count: items.length, items });
}
