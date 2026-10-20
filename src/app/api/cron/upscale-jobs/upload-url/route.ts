import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { designs } from "@/db/schema";
import { presignImageUpload } from "@/lib/object-storage";
import { bindUploadKey } from "@/lib/upscale-failures";
import { authorizedUpscaleJob } from "@/lib/upscale-jobs";

export const dynamic = "force-dynamic";

/** POST ?designId= — a 15-minute presigned S3 PUT bound to that design. The worker then calls complete?key=. */
export async function POST(req: Request) {
  if (!authorizedUpscaleJob(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const designId = Number(new URL(req.url).searchParams.get("designId"));
  if (!Number.isInteger(designId) || designId < 1) return NextResponse.json({ error: "designId required" }, { status: 400 });
  const db = await getDb();
  const [design] = await db.select({ id: designs.id }).from(designs).where(eq(designs.id, designId));
  if (!design) return NextResponse.json({ error: "design not found" }, { status: 404 });
  const signed = await presignImageUpload("image/png");
  if (!signed) return NextResponse.json({ error: "S3 storage not configured" }, { status: 503 });
  await bindUploadKey(db, signed.key, designId);
  return NextResponse.json(signed);
}
