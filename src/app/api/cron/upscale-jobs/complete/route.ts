import sharp from "sharp";
import { NextResponse, after } from "next/server";
import { primeArtworkBytes } from "@/lib/artwork-source";
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
  const t0 = Date.now();
  const step = (name: string) => console.log(`[upscale-jobs] design #${designId} complete step ${name} +${Date.now() - t0}ms`);
  let bytes: Buffer;
  let presetStored: { url: string; key: string } | null = null;
  if (key) {
    if (!MEDIA_KEY.test(key)) return NextResponse.json({ error: "invalid key" }, { status: 400 });
    if (!(await consumeUploadKey(await getDb(), key, designId))) {
      return NextResponse.json({ error: `key was not issued for design #${designId} or was already used` }, { status: 403 });
    }
    step("key-consumed");
    const object = await readStoredObject(key);
    step(`s3-read ${object?.bytes.length ?? 0}B`);
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
  step("target");
  if (!target) return reject({ error: `design #${designId} not found` }, 404);
  if (meta.width < target.minW || meta.height < target.minH) {
    return reject({ error: `upscale ${meta.width}×${meta.height} is below the ${target.minW}×${target.minH} minimum for this product`, target }, 422);
  }
  // Full edge check on every upload. Bright blank bands are trimmed (then the size floor is re-checked);
  // dark/flat bands are never cut — they only mark the design for Design review.
  const { analysisRaw, flatEdgeBands, trimBlankEdges } = await import("@/lib/edge-check");
  const raw = await analysisRaw(bytes);
  const trim = await trimBlankEdges(bytes, { width: target.minW, height: target.minH }, raw);
  const b = trim.bands;
  if (!trim.ok) {
    console.log(`[upscale-jobs] design #${designId} edge check: REJECT ${trim.reason}`);
    return reject({ error: trim.reason, bands: b }, 422);
  }
  const flat = await flatEdgeBands(trim.bytes, trim.bytes === bytes ? raw : undefined);
  step("edge-check");
  console.log(`[upscale-jobs] design #${designId} edge check: bright top ${b.top} bottom ${b.bottom} left ${b.left} right ${b.right}px${b.blank ? ` → trimmed to ${b.trimmed.width}×${b.trimmed.height}` : " (clean)"}; dark/flat ${flat.review ? `top ${flat.top} bottom ${flat.bottom} left ${flat.left} right ${flat.right}px → Design review` : "none"}`);
  let finalBytes = bytes;
  let size = { width: meta.width, height: meta.height };
  let stored: { url: string; key: string } | null = presetStored;
  if (b.blank) {
    finalBytes = trim.bytes;
    size = { width: b.trimmed.width, height: b.trimmed.height };
    stored = await uploadImageBytes(finalBytes, "image/png");
    if (presetStored) await deleteStoredObject(presetStored.key).catch(() => false);
  }
  stored ??= await uploadImageBytes(finalBytes, "image/png");
  if (!stored) return NextResponse.json({ error: "object storage is not configured" }, { status: 503 });
  const finalSha = b.blank ? createHash("sha256").update(finalBytes).digest("hex") : sha256;
  const processed = { url: stored.url, upscaleMethod: "realesrgan" as const, sourcePx: { width: srcW, height: srcH }, outputPx: size };
  primeArtworkBytes(stored.url, finalBytes);
  const storedKey = stored.key, storedUrl = stored.url;
  console.log(`[upscale-jobs] design #${designId} realesrgan ${srcW}×${srcH} → ${size.width}×${size.height} stored ${storedKey} (${finalBytes.length} bytes, sha256 ${finalSha}, measured server-side)`);
  step("stored");
  // Copy/quality gates, A3 crop + per-product print files and the review flag run after the response
  // (they read the primed bytes, not S3) so the worker gets its 200 well under the timeout.
  const postStore = async () => {
    try {
      await upscaleDesigns(db, [designId], true, new Map([[designId, processed]]));
      step("gates");
      await db.update(designs).set({ upscaleFailure: null, ...(flat.review ? { designReview: { status: "pending" as const, note: "dark/flat edge bands — check at zoom", at: new Date().toISOString() } } : {}) }).where(eq(designs.id, designId));
      await attachA3Crop(db, designId, finalBytes, storedUrl, size);
      step("a3+print-files");
      await clearRedesignFlag(db, designId, size);
      step("done");
    } catch (error) {
      console.error(`[upscale-jobs] design #${designId} post-store step failed: ${error instanceof Error ? error.message.slice(0, 200) : "error"}`);
    }
  };
  // Outside a Next request scope (tests, scripts) after() throws; run inline then.
  let deferred = true;
  try { after(postStore); } catch { deferred = false; await postStore(); }
  const edge = { bright: { top: b.top, bottom: b.bottom, left: b.left, right: b.right, trimmed: b.blank }, flat };
  return NextResponse.json({ designId, key: storedKey, url: storedUrl, bytes: finalBytes.length, sha256: finalSha, outputPx: size, edge, postStore: deferred ? "running" : "done" });
}
