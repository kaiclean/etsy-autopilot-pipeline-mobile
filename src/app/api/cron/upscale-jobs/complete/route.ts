import { sql } from "drizzle-orm";
import { enqueueJob, findJob, drainJobs } from "@/lib/durable-jobs";
import { assertOperationAllowed } from "@/lib/operation-policy";
import sharp from "sharp";
import { NextResponse, after } from "next/server";
import { getDb } from "@/db";
import { MAX_ARTWORK_BYTES } from "@/lib/object-storage";
import { deleteStoredObject, readStoredObject, storedUrlForKey, uploadImageBytes, MEDIA_KEY } from "@/lib/object-storage";
import { createHash } from "node:crypto";
import { consumeUploadKey } from "@/lib/upscale-failures";
import { designs } from "@/db/schema";
import { eq } from "drizzle-orm";
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
  if (!Number.isInteger(designId) || designId < 1 || method !== "realesrgan" || !Number.isInteger(srcW) || srcW < 1 || !Number.isInteger(srcH) || srcH < 1) {
    return NextResponse.json({ error: "designId, method=realesrgan, srcW and srcH are required" }, { status: 400 });
  }
  // Preferred: the worker PUT the PNG to S3 via a presigned URL and sends only ?key=. The server downloads it and
  // measures pixels + sha256 itself; worker-reported sizes are never trusted.
  const dbGuard=await getDb();
  const lease=await dbGuard.execute<{owner:string;valid:boolean}>(sql`select owner,expires_at>now() as valid from upscale_work_leases where design_id=${designId}`);
  if(lease.rows.length && (!lease.rows[0].valid || lease.rows[0].owner!==params.get("token"))) return NextResponse.json({error:"Worker lease lost"},{status:409});
  const key = params.get("key");
  const t0 = Date.now();
  const step = (name: string) => console.log(`[upscale-jobs] design #${designId} complete step ${name} +${Date.now() - t0}ms`);
  let bytes: Buffer;
  let presetStored: { url: string; key: string } | null = null;
  if (key) {
    if (!MEDIA_KEY.test(key)) return NextResponse.json({ error: "invalid key" }, { status: 400 });
    const db=await getDb();
    const existing=await findJob(db,`upscale:${designId}:${key}`);
    if(existing) return NextResponse.json({designId,jobId:existing.id,status:existing.status,postStore:existing.status});
    const issued=await db.execute(sql`select u.key from upscale_uploads u join designs d on d.id=u.design_id where u.key=${key} and u.design_id=${designId} and u.consumed_at is null and (u.source_url is null or u.source_url=d.image_url)`);
    if (!issued.rows.length) {
      return NextResponse.json({ error: `key was not issued for design #${designId} or was already used` }, { status: 403 });
    }
    step("key-validated");
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
  const [source]=await db.select().from(designs).where(eq(designs.id,designId));
  if(!source) return reject({error:"design not found"},404);
  await assertOperationAllowed(db,source.shopId);
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
  const job=await enqueueJob(db,source.shopId,"upscale",`upscale:${designId}:${key ?? stored.key}`,{
    designId,key:stored.key,url:stored.url,sourceUrl:source.imageUrl,sourcePx:{width:srcW,height:srcH},outputPx:size,flatReview:flat.review,sha256:finalSha,
  });
  if(key) await consumeUploadKey(db,key,designId);
  // The bytes and durable intent survive a lost post-response callback or deployment.
  try { after(async()=>{ await drainJobs(db,1); }); } catch { /* Scheduled drain owns recovery outside request scope. */ }
  const storedKey=stored.key,storedUrl=stored.url;
  const edge = { bright: { top: b.top, bottom: b.bottom, left: b.left, right: b.right, trimmed: b.blank }, flat };
  return NextResponse.json({ designId, key: storedKey, url: storedUrl, bytes: finalBytes.length, sha256: finalSha, outputPx: size, edge, jobId:job.id,postStore:"queued" });
}
