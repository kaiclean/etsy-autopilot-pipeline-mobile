import { NextResponse } from "next/server";
import { presignImageUpload } from "@/lib/object-storage";
import { authorizedUpscaleJob } from "@/lib/upscale-jobs";

export const dynamic = "force-dynamic";

/** POST — a 15-minute presigned S3 PUT for the box worker's PNG. The worker then calls complete?key=. */
export async function POST(req: Request) {
  if (!authorizedUpscaleJob(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const signed = await presignImageUpload("image/png");
  if (!signed) return NextResponse.json({ error: "S3 storage not configured" }, { status: 503 });
  return NextResponse.json(signed);
}
