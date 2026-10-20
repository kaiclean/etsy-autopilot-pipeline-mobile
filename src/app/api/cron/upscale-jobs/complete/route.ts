import sharp from "sharp";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { upscaleDesigns } from "@/db/upscale-designs";
import { MAX_ARTWORK_BYTES } from "@/lib/object-storage";
import { deleteStoredObject, readStoredObject, storedUrlForKey, uploadImageBytes, MEDIA_KEY } from "@/lib/object-storage";
import { createHash } from "node:crypto";
import { consumeUploadKey } from "@/lib/upscale-failures";
import { designs } from "@/db/schema";
import { eq } from "drizzle-orm";
import { attachA3Crop, authorizedUpscaleJob, clearRedesignFlag, requiredUpscaleTarget } from "@/lib/upscale-jobs";

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
  // Preferred: the worker PUT the PNG to S3 via a presigned URL and sends only ?key=. The server downloads it and
  // measures pixels + sha256 itself; worker-reported sizes are never trusted.
  const key = params.get("key");
  let bytes: Buffer;
  let presetStored: { url: string; key: string } | null = null;
  if (key) {
    if (!MEDIA_KEY.test(key)) return NextResponse.json({ error: "invalid key" }, { status: 400 });
    if (!(await consumeUploadKey(await getDb(), key, designId))) {
      return NextResponse.json({ error: `key was not issued for design #${designId} or was already used` }, { status: 403 });
    }
    const object = await readStoredObject(key);
    if (!object) return NextResponse.json({ error: "uploaded object not found" }, { status: 404 });
    bytes = Buffer.from(object.bytes);
    presetStored = { key, url: await storedUrlForKey(key) };
  } else {
    bytes = Buffer.from(await req.arrayBuffer());
  }
  // A rejected presigned upload is deleted from S3 so no unverified file lingers.
  const reject = async (body: Record<string, unknown>, status: number) => {
    if (presetStored) await deleteStoredObject(presetStored.key).catch(() => false);
    if (presetStored) console.log(`[upscale-jobs] design #${designId} rejected upload ${presetStored.key} deleted (${status})`);
    return NextResponse.json(body, { status });
  };
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (!bytes.length || bytes.length > MAX_ARTWORK_BYTES) return reject({ error: "PNG body missing or too large" }, 413);
  const meta = await sharp(bytes, { limitInputPixels: 128_000_000 }).metadata().catch(() => null);
  if (!meta || meta.format !== "png" || !meta.width || !meta.height) return reject({ error: "body must be a PNG" }, 415);
  const db = await getDb();
  const target = await requiredUpscaleTarget(db, designId);
  if (!target) return reject({ error: `design #${designId} not found` }, 404);
  if (meta.width < target.minW || meta.height < target.minH) {
    return reject({ error: `upscale ${meta.width}×${meta.height} is below the ${target.minW}×${target.minH} minimum for this product`, target }, 422);
  }
  // Edge check applies to full-bleed redesigns only (white-background clipart legitimately has white edges).
  const [flagged] = await db.select({ flag: designs.needsRedesign }).from(designs).where(eq(designs.id, designId));
  const { blankEdgeBands } = await import("@/lib/edge-check");
  const bands = flagged?.flag ? await blankEdgeBands(bytes) : { blank: false, top: 0, bottom: 0, left: 0, right: 0, trimmed: { width: meta.width, height: meta.height } };
  console.log(`[upscale-jobs] design #${designId} edge check: top ${bands.top} bottom ${bands.bottom} left ${bands.left} right ${bands.right}px`);
  if (bands.blank && (bands.trimmed.width < target.minW || bands.trimmed.height < target.minH)) {
    return reject({ error: `blank edge bands; trimmed ${bands.trimmed.width}×${bands.trimmed.height} is below ${target.minW}×${target.minH}`, bands }, 422);
  }
  const stored = presetStored ?? await uploadImageBytes(bytes, "image/png");
  if (!stored) return NextResponse.json({ error: "object storage is not configured" }, { status: 503 });
  const processed = { url: stored.url, upscaleMethod: "realesrgan" as const, sourcePx: { width: srcW, height: srcH }, outputPx: { width: meta.width, height: meta.height } };
  const report = await upscaleDesigns(db, [designId], true, new Map([[designId, processed]]));
  console.log(`[upscale-jobs] design #${designId} realesrgan ${srcW}×${srcH} → ${meta.width}×${meta.height} stored ${stored.key} (${bytes.length} bytes, sha256 ${sha256}, measured server-side)`);
  await db.update(designs).set({ upscaleFailure: null }).where(eq(designs.id, designId));
  const digital = await attachA3Crop(db, designId, bytes, stored.url, { width: meta.width, height: meta.height });
  const cleared = await clearRedesignFlag(db, designId, { width: meta.width, height: meta.height });
  return NextResponse.json({ designId, key: stored.key, url: stored.url, bytes: bytes.length, sha256, outputPx: processed.outputPx, digital, redesignCleared: cleared, report });
}
