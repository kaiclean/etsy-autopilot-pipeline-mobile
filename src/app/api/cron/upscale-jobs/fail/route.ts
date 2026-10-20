import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { recordUpscaleFailure } from "@/lib/upscale-failures";
import { authorizedUpscaleJob } from "@/lib/upscale-jobs";

export const dynamic = "force-dynamic";

/** POST ?designId=&error= — the worker reports a failed upload/report; 3 strikes marks the job failed. */
export async function POST(req: Request) {
  if (!authorizedUpscaleJob(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const params = new URL(req.url).searchParams;
  const designId = Number(params.get("designId"));
  if (!Number.isInteger(designId) || designId < 1) return NextResponse.json({ error: "designId required" }, { status: 400 });
  const failure = await recordUpscaleFailure(await getDb(), designId, params.get("error") ?? "unknown");
  if (!failure) return NextResponse.json({ error: "design not found" }, { status: 404 });
  return NextResponse.json({ designId, ...failure });
}
