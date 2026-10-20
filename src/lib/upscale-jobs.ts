import { and, desc, eq, inArray, isNotNull, isNull, ne, or } from "drizzle-orm";
import type { DB } from "@/db";
import { designBriefs, designs, listings } from "@/db/schema";
import { config, publicAppUrl } from "@/lib/config";
import { isPodPreset } from "@/lib/fees";
import { PRINT_TARGETS, getPrintTarget, type PrintTarget, type PrintTargetKey } from "@/lib/print-targets";

export type UpscaleJobRow = {
  designId: number;
  source: string;
  target: PrintTarget;
  fallbackTarget?: PrintTarget;
  posterFinish: boolean;
  reason: string;
};

/** Accepts Bearer CRON_SECRET or the dedicated UPSCALER_SECRET (box worker). */
export function authorizedUpscaleJob(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const secrets = [config.cronSecret, config.upscale.workerSecret].filter((value): value is string => Boolean(value && value.length >= 16));
  return secrets.some((secret) => auth === `Bearer ${secret}`);
}

function absolute(url: string) {
  return url.startsWith("/") ? `${publicAppUrl()}${url}` : url;
}

/**
 * Designs that still need a Real-ESRGAN pass: lanczos output, or no upscale yet while an open listing
 * is held for low-resolution / AI-upscale reasons. Live (non-demo) rows only.
 */
/** Products a design feeds: POD presets from its listings, else its brief; empty = digital only. */
export function designPresets(podProviders: readonly (string | null)[], brief: { productType: string | null; podPreset: string | null } | null): PrintTargetKey[] {
  // Mugs need a wrap aspect (not 4:5) and stay held, so they don't shape the shared print target.
  const presets = [...new Set(podProviders.map((value) => value?.replace(/^printify:/, "") ?? "").filter((value): value is PrintTargetKey => isPodPreset(value) && value !== "mug"))];
  if (!presets.length && brief?.productType === "pod") presets.push(isPodPreset(brief.podPreset ?? "") ? brief.podPreset as PrintTargetKey : "posterA3");
  return presets;
}

/** Max of each dimension across the resolved targets, so one file satisfies every product. */
export function combineTargets(targets: readonly PrintTarget[]): PrintTarget {
  return targets.reduce((acc, t) => ({
    minW: Math.max(acc.minW, t.minW), minH: Math.max(acc.minH, t.minH),
    targetW: Math.max(acc.targetW, t.targetW), targetH: Math.max(acc.targetH, t.targetH),
  }));
}

/** Real-ESRGAN x4plus is a 4× model: a cover-fit beyond 4× would need non-AI interpolation, so Design rebuilds instead. */
export const MAX_AI_SCALE = 4;
export function reachableBy4x(source: { width: number; height: number }, target: PrintTarget) {
  const scale = Math.max(target.minW / source.width, target.minH / source.height);
  return { reachable: scale <= MAX_AI_SCALE, scale: Math.round(scale * 100) / 100 };
}

async function targetFor(brief: { productType: string | null; podPreset: string | null } | null, podProviders: readonly (string | null)[] = []) {
  const presets = designPresets(podProviders, brief);
  if (!presets.length) return { key: "digitalLarge" as PrintTargetKey, presets, target: PRINT_TARGETS.digitalLarge };
  const target = combineTargets(await Promise.all(presets.map((key) => getPrintTarget(key))));
  return { key: (presets.includes("posterA3") ? "posterA3" : presets[0]) as PrintTargetKey, presets, target };
}

/** Minimum the box result must meet for this design's product (digital accepts its fallback size). */
export async function requiredUpscaleTarget(db: DB, designId: number): Promise<PrintTarget | null> {
  const [row] = await db.select({ id: designs.id, brief: designBriefs }).from(designs)
    .leftJoin(designBriefs, eq(designs.keywordId, designBriefs.keywordId)).where(eq(designs.id, designId)).limit(1);
  if (!row) return null;
  const products = await db.select({ podProvider: listings.podProvider }).from(listings).where(eq(listings.designId, designId));
  const { key, target } = await targetFor(row.brief, products.map((item) => item.podProvider));
  return key === "digitalLarge" ? PRINT_TARGETS.digital : target;
}

/** Resolved combined target for a design from all its listings (and brief). */
export async function designTarget(db: DB, designId: number) {
  const [row] = await db.select({ brief: designBriefs }).from(designs)
    .leftJoin(designBriefs, eq(designs.keywordId, designBriefs.keywordId)).where(eq(designs.id, designId)).limit(1);
  const products = await db.select({ podProvider: listings.podProvider }).from(listings).where(eq(listings.designId, designId));
  return targetFor(row?.brief ?? null, products.map((item) => item.podProvider));
}

/** Persist + log the full-size redesign flag once; Design reads the list from /api/cron/redesign-queue. */
export async function flagRedesign(db: DB, row: NeedsDesignRow) {
  const [current] = await db.select({ flag: designs.needsRedesign }).from(designs).where(eq(designs.id, row.designId));
  if (current?.flag) return false;
  const reason = `source ${row.sourcePx.width}×${row.sourcePx.height} needs ${row.scale}× to reach ${row.target.minW}×${row.target.minH} (${row.presets.join(",")}); Real-ESRGAN is 4×`;
  await db.update(designs).set({ needsRedesign: { reason, sourcePx: row.sourcePx, target: row.target, presets: row.presets, scale: row.scale, at: new Date().toISOString() } }).where(eq(designs.id, row.designId));
  console.log(`[upscale-jobs] design #${row.designId} needs full-size redesign: ${reason}`);
  return true;
}

export async function redesignQueue(db: DB) {
  const rows = await db.select({ id: designs.id, prompt: designs.prompt, niche: designs.niche, keywordId: designs.keywordId, flag: designs.needsRedesign, imageUrl: designs.imageUrl })
    .from(designs).where(and(eq(designs.isDemo, false), isNotNull(designs.needsRedesign)));
  return rows;
}

export type NeedsDesignRow = { designId: number; sourcePx: { width: number; height: number }; presets: PrintTargetKey[]; target: PrintTarget; scale: number };

export async function pendingUpscaleJobs(db: DB, limit = 3, needsDesign: NeedsDesignRow[] = []): Promise<UpscaleJobRow[]> {
  const all = await db.select({ designId: listings.designId, podProvider: listings.podProvider }).from(listings).where(eq(listings.isDemo, false));
  const productsByDesign = new Map<number, (string | null)[]>();
  for (const row of all) if (row.designId) productsByDesign.set(row.designId, [...(productsByDesign.get(row.designId) ?? []), row.podProvider]);
  const held = await db.select({ designId: listings.designId, validation: listings.validation }).from(listings)
    .where(and(inArray(listings.status, ["pending_approval", "quality_failed"]), isNull(listings.activatedAt), eq(listings.isDemo, false)));
  const heldIds = new Set(held.filter((row) => (row.validation ?? []).some((issue) => issue.code === "low_res_art" || issue.code === "ai_upscale_required"))
    .map((row) => row.designId).filter((id): id is number => typeof id === "number"));
  const rows = await db.select({ design: designs, brief: designBriefs }).from(designs)
    .leftJoin(designBriefs, eq(designs.keywordId, designBriefs.keywordId))
    .where(and(eq(designs.isDemo, false), ne(designs.status, "discarded"), ne(designs.status, "rejected"),
      or(eq(designs.upscaleMethod, "lanczos"), eq(designs.upscaleMethod, "realesrgan"), isNull(designs.upscaleMethod))))
    .orderBy(desc(designs.id)).limit(200);
  const out: UpscaleJobRow[] = [];
  for (const { design, brief } of rows) {
    if (out.length >= limit) break;
    if (design.upscaleFailure?.failed) continue; // 3 failed reports: shown on the dashboard, not retried
    const lanczos = design.upscaleMethod === "lanczos";
    const { key, target, presets } = await targetFor(brief, productsByDesign.get(design.id) ?? []);
    const minimum = key === "digitalLarge" ? PRINT_TARGETS.digital : target;
    // Re-queue earlier Real-ESRGAN output that falls short of the current product minimum (e.g. A3 3510×4950).
    const short = design.upscaleMethod === "realesrgan" && ((design.imageWidth ?? 0) < minimum.minW || (design.imageHeight ?? 0) < minimum.minH);
    if (!lanczos && !short && !(design.upscaleMethod === null && (heldIds.has(design.id) || design.needsRedesign))) continue;
    const source = design.sourceImageUrl ?? design.imageUrl;
    if (!source || source.startsWith("/api/placeholder")) continue;
    const sourcePx = design.sourcePx ?? (design.upscaleMethod === null && design.imageWidth && design.imageHeight ? { width: design.imageWidth, height: design.imageHeight } : null);
    if (presets.length && sourcePx) {
      if (!design.sourcePx) await db.update(designs).set({ sourcePx }).where(eq(designs.id, design.id));
      const reach = reachableBy4x(sourcePx, target);
      if (!reach.reachable) {
        const row = { designId: design.id, sourcePx, presets, target, scale: reach.scale };
        needsDesign.push(row);
        await flagRedesign(db, row);
        continue;
      }
    }
    // Reachable in one pass: deliver the native 4× master (e.g. 1024×1280 → 4096×5120) without resampling.
    const native = presets.length && sourcePx && sourcePx.width * 4 >= target.minW && sourcePx.height * 4 >= target.minH
      ? { ...target, targetW: sourcePx.width * 4, targetH: sourcePx.height * 4 } : target;
    out.push({
      designId: design.id,
      source: absolute(source),
      target: native,
      ...(key === "digitalLarge" ? { fallbackTarget: PRINT_TARGETS.digital } : {}),
      posterFinish: config.upscale.posterFinish && (key === "posterA3" || key === "canvas"),
      reason: lanczos ? "lanczos output" : short ? "realesrgan output below product minimum" : "held: too small for print",
    });
  }
  return out;
}

/** A3 aspect (297×420 mm): the A3 crop of a 4:5 master keeps full height, e.g. 4096×5120 → 3620×5120. */
export function a3CropSize(master: { width: number; height: number }) {
  const width = Math.min(master.width, Math.round(master.height * 3508 / 4961));
  return { width, height: width < master.width ? master.height : Math.min(master.height, Math.round(width * 4961 / 3508)) };
}

/** Digital listings of the design ship the 4:5 master plus an A3 centre crop (≥3508×4961). Both sizes are logged. */
export async function attachA3Crop(db: DB, designId: number, master: Buffer, masterUrl: string, size: { width: number; height: number }) {
  const open = await db.select({ id: listings.id, productType: listings.productType, podProvider: listings.podProvider }).from(listings)
    .where(and(eq(listings.designId, designId), isNull(listings.activatedAt), inArray(listings.status, ["pending_approval", "quality_failed"])));
  const rows = open.filter((row) => row.productType === "digital");
  const posters = open.filter((row) => row.productType === "pod" && row.podProvider?.startsWith("printify:"));
  if (!rows.length && !posters.length) return null;
  const crop = a3CropSize(size);
  if (crop.width < 3508 || crop.height < 4961) return { skipped: `A3 crop ${crop.width}×${crop.height} is below 3508×4961` };
  const { default: sharp } = await import("sharp");
  const cropBytes = await sharp(master, { limitInputPixels: 128_000_000 })
    .extract({ left: Math.floor((size.width - crop.width) / 2), top: Math.floor((size.height - crop.height) / 2), width: crop.width, height: crop.height }).png().toBuffer();
  const { uploadImageBytes } = await import("@/lib/object-storage");
  const { inspectArtworkFile } = await import("@/lib/file-manifest");
  const stored = await uploadImageBytes(cropBytes, "image/png");
  const masterRecord = await inspectArtworkFile(master, `design-${designId}-4x5-master.png`);
  const cropRecord = await inspectArtworkFile(cropBytes, `design-${designId}-A3.png`);
  if (!stored || !masterRecord || !cropRecord) return { skipped: "could not store or inspect the A3 crop" };
  // Ratio rule: each POD product gets the file closest to its live Printify print-area aspect (≤3%), covering its pixels;
  // apparel may get the master fitted with transparent padding; mugs and anything else are held with no file.
  const { assignPrintFile } = await import("@/lib/print-file-assign");
  const { getPrintArea } = await import("@/lib/print-targets");
  const assigned: Record<number, string> = {};
  for (const row of posters) {
    const preset = row.podProvider!.replace(/^printify:/, "");
    const fallback = PRINT_TARGETS[preset as PrintTargetKey];
    const area = isPodPreset(preset) ? (await getPrintArea(preset)) ?? (fallback ? { width: fallback.targetW, height: fallback.targetH } : null) : null;
    const choice = area ? assignPrintFile(preset, area, size, crop) : { file: "none" as const, reason: "no print area" };
    let url: string | null = null;
    if (choice.file === "a3") url = stored.url;
    else if (choice.file === "master") url = masterUrl;
    else if (choice.file === "padded" && area) {
      const fitted = await sharp(master, { limitInputPixels: 128_000_000 }).resize(choice.fit.width, choice.fit.height).png().toBuffer();
      const padded = await sharp({ create: { width: area.width, height: area.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .composite([{ input: fitted, left: Math.floor((area.width - choice.fit.width) / 2), top: 0 }]).png().toBuffer();
      url = (await uploadImageBytes(padded, "image/png"))?.url ?? null;
    }
    const [current] = await db.select({ validation: listings.validation }).from(listings).where(eq(listings.id, row.id));
    const kept = (current?.validation ?? []).filter((issue) => issue.code !== "print_file_held");
    await db.update(listings).set({
      deliveryUrl: url,
      printFit: choice.file === "padded" ? "fitted" as const : url ? "fill" as const : null,
      ...(url ? { validation: kept } : {
        status: "quality_failed" as const,
        validation: [...kept, { field: "image" as const, severity: "error" as const, code: "print_file_held", message: `Held: ${choice.reason}` }],
      }),
      updatedAt: new Date(),
    }).where(eq(listings.id, row.id));
    assigned[row.id] = choice.file;
    console.log(`[upscale-jobs] design #${designId} listing ${row.id} ${preset}: print file = ${choice.file} (${choice.reason})`);
  }
  for (const row of rows) {
    await db.update(listings).set({
      deliveryUrl: masterUrl,
      deliveryPack: { version: 1, source: masterRecord, files: [{ ...masterRecord, url: masterUrl }, { ...cropRecord, url: stored.url }] },
      fileVerifiedAt: null, fileVerifiedBy: null, updatedAt: new Date(),
    }).where(eq(listings.id, row.id));
  }
  console.log(`[upscale-jobs] design #${designId} digital files: master ${size.width}×${size.height}, A3 crop ${crop.width}×${crop.height} (${stored.key}) on listings ${rows.map((row) => row.id).join(",")}`);
  return { master: size, a3: crop, a3Url: stored.url, listings: rows.map((row) => row.id), posters: assigned };
}

/** Size check passed: the flag stays until Design signs off; the design is marked review-pending (blocks approval). */
export async function clearRedesignFlag(db: DB, designId: number, size: { width: number; height: number }) {
  const [row] = await db.select({ flag: designs.needsRedesign }).from(designs).where(eq(designs.id, designId));
  if (!row?.flag || size.width < row.flag.target.minW || size.height < row.flag.target.minH) return false;
  await db.update(designs).set({ designReview: { status: "pending", at: new Date().toISOString() } }).where(eq(designs.id, designId));
  console.log(`[upscale-jobs] design #${designId} meets ${row.flag.target.minW}×${row.flag.target.minH} at ${size.width}×${size.height}; redesign flag KEPT, design review pending`);
  return false;
}
