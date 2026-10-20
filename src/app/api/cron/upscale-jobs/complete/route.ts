import sharp from "sharp";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { upscaleDesigns } from "@/db/upscale-designs";
import { MAX_ARTWORK_BYTES } from "@/lib/object-storage";
import { uploadImageBytes } from "@/lib/object-storage";
import { authorizedUpscaleJob, requiredUpscaleTarget } from "@/lib/upscale-jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Box worker report: body is the upscaled PNG; query designId, method=realesrgan, srcW, srcH.
 * Stores it in S3, updates the design, and re-runs listing copy + quality gates (upscaleDesigns --apply).
 */
export async function POST(req: Request) {
  if (!authorizedUpscaleJob(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const params = new URL(req.url).searchParams;
  const designId = Number(params.get("designId"));
  const method = params.get("method");
  const srcW = Number(params.get("srcW"));
  const srcH = Number(params.get("srcH"));
  if (!Number.isInteger(designId) || designId < 1 || method !== "realesrgan" || !Number.isInteger(srcW) || !Number.isInteger(srcH)) {
    return NextResponse.json({ error: "designId, method=realesrgan, srcW and srcH are required" }, { status: 400 });
  }
  const bytes = Buffer.from(await req.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_ARTWORK_BYTES) return NextResponse.json({ error: "PNG body missing or too large" }, { status: 413 });
  const meta = await sharp(bytes, { limitInputPixels: 128_000_000 }).metadata().catch(() => null);
  if (!meta || meta.format !== "png" || !meta.width || !meta.height) return NextResponse.json({ error: "body must be a PNG" }, { status: 415 });
  const db = await getDb();
  const target = await requiredUpscaleTarget(db, designId);
  if (!target) return NextResponse.json({ error: `design #${designId} not found` }, { status: 404 });
  if (meta.width < target.minW || meta.height < target.minH) {
    return NextResponse.json({ error: `upscale ${meta.width}×${meta.height} is below the ${target.minW}×${target.minH} minimum for this product`, target }, { status: 422 });
  }
  const stored = await uploadImageBytes(bytes, "image/png");
  if (!stored) return NextResponse.json({ error: "object storage is not configured" }, { status: 503 });
  const processed = { url: stored.url, upscaleMethod: "realesrgan" as const, sourcePx: { width: srcW, height: srcH }, outputPx: { width: meta.width, height: meta.height } };
  const report = await upscaleDesigns(db, [designId], true, new Map([[designId, processed]]));
  console.log(`[upscale-jobs] design #${designId} realesrgan ${srcW}×${srcH} → ${meta.width}×${meta.height} stored ${stored.key}`);
  return NextResponse.json({ designId, key: stored.key, outputPx: processed.outputPx, report });
}
