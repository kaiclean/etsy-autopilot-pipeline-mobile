import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { authorizedUpscaleJob, pendingUpscaleJobs, type NeedsDesignRow } from "@/lib/upscale-jobs";

export const dynamic = "force-dynamic";

/** Box worker pull: designs that still need a Real-ESRGAN upscale. Read-only. */
export async function GET(req: Request) {
  if (!authorizedUpscaleJob(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const limit = Math.min(10, Math.max(1, Number(new URL(req.url).searchParams.get("limit") ?? 3) || 3));
  const needsDesign: NeedsDesignRow[] = [];
  const jobs = await pendingUpscaleJobs(await getDb(), limit, needsDesign);
  // needsDesign: print targets a 4× Real-ESRGAN pass cannot reach from the source; Design rebuilds these at full size.
  return NextResponse.json({ jobs, needsDesign });
}
