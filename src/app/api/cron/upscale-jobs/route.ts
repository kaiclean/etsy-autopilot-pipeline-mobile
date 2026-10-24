import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { authorizedUpscaleJob, pendingUpscaleJobs, type NeedsDesignRow } from "@/lib/upscale-jobs";

export const dynamic = "force-dynamic";

/** Box worker pull: designs that still need a Real-ESRGAN upscale. Read-only. */
export async function GET(req: Request) {
  if (!authorizedUpscaleJob(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const limit = Math.min(10, Math.max(1, Number(new URL(req.url).searchParams.get("limit") ?? 3) || 3));
  const needsDesign: NeedsDesignRow[] = [];
  const db=await getDb();
  await db.execute(sql`insert into worker_heartbeats (key) values ('upscaler') on conflict (key) do update set seen_at=now()`);
  const candidates = await pendingUpscaleJobs(db, limit, needsDesign);
  const jobs=[];
  for(const job of candidates) {
    const token=randomUUID();
    const claimed=await db.execute(sql`insert into upscale_work_leases(design_id,owner,expires_at) values (${job.designId},${token}::uuid,now()+interval '30 minutes') on conflict (design_id) do update set owner=excluded.owner,expires_at=excluded.expires_at where upscale_work_leases.expires_at<now() returning owner`);
    if(claimed.rows.length) jobs.push({...job,token});
  }
  // needsDesign: print targets a 4× Real-ESRGAN pass cannot reach from the source; Design rebuilds these at full size.
  return NextResponse.json({ jobs, needsDesign });
}
