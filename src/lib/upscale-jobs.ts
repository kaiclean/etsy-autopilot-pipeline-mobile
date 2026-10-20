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
async function targetFor(brief: { productType: string | null; podPreset: string | null } | null) {
  const key: PrintTargetKey = brief?.productType === "pod"
    ? (isPodPreset(brief.podPreset ?? "") ? brief.podPreset as PrintTargetKey : "posterA3")
    : "digitalLarge";
  const target = key === "digitalLarge" ? PRINT_TARGETS.digitalLarge : await getPrintTarget(key);
  return { key, target };
}

/** Minimum the box result must meet for this design's product (digital accepts its fallback size). */
export async function requiredUpscaleTarget(db: DB, designId: number): Promise<PrintTarget | null> {
  const [row] = await db.select({ id: designs.id, brief: designBriefs }).from(designs)
    .leftJoin(designBriefs, eq(designs.keywordId, designBriefs.keywordId)).where(eq(designs.id, designId)).limit(1);
  if (!row) return null;
  const { key, target } = await targetFor(row.brief);
  return key === "digitalLarge" ? PRINT_TARGETS.digital : target;
}

export async function pendingUpscaleJobs(db: DB, limit = 3): Promise<UpscaleJobRow[]> {
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
    const { key, target } = await targetFor(brief);
    const minimum = key === "digitalLarge" ? PRINT_TARGETS.digital : target;
    // Re-queue earlier Real-ESRGAN output that falls short of the current product minimum (e.g. A3 3510×4950).
    const short = design.upscaleMethod === "realesrgan" && ((design.imageWidth ?? 0) < minimum.minW || (design.imageHeight ?? 0) < minimum.minH);
    if (!lanczos && !short && !(design.upscaleMethod === null && heldIds.has(design.id))) continue;
    const source = design.sourceImageUrl ?? design.imageUrl;
    if (!source || source.startsWith("/api/placeholder")) continue;
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
