import { and, desc, eq, inArray, isNull, ne, or } from "drizzle-orm";
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
  const presets = [...new Set(podProviders.map((value) => value?.replace(/^printify:/, "") ?? "").filter((value): value is PrintTargetKey => isPodPreset(value)))];
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
    const lanczos = design.upscaleMethod === "lanczos";
    const { key, target, presets } = await targetFor(brief, productsByDesign.get(design.id) ?? []);
    const minimum = key === "digitalLarge" ? PRINT_TARGETS.digital : target;
    // Re-queue earlier Real-ESRGAN output that falls short of the current product minimum (e.g. A3 3510×4950).
    const short = design.upscaleMethod === "realesrgan" && ((design.imageWidth ?? 0) < minimum.minW || (design.imageHeight ?? 0) < minimum.minH);
    if (!lanczos && !short && !(design.upscaleMethod === null && heldIds.has(design.id))) continue;
    const source = design.sourceImageUrl ?? design.imageUrl;
    if (!source || source.startsWith("/api/placeholder")) continue;
    const sourcePx = design.sourcePx ?? (design.upscaleMethod === null && design.imageWidth && design.imageHeight ? { width: design.imageWidth, height: design.imageHeight } : null);
    if (presets.length && sourcePx) {
      const reach = reachableBy4x(sourcePx, target);
      if (!reach.reachable) {
        needsDesign.push({ designId: design.id, sourcePx, presets, target, scale: reach.scale });
        continue;
      }
    }
    out.push({
      designId: design.id,
      source: absolute(source),
      target,
      ...(key === "digitalLarge" ? { fallbackTarget: PRINT_TARGETS.digital } : {}),
      posterFinish: config.upscale.posterFinish && (key === "posterA3" || key === "canvas"),
      reason: lanczos ? "lanczos output" : short ? "realesrgan output below product minimum" : "held: too small for print",
    });
  }
  return out;
}
