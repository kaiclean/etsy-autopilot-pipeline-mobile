import { mediaUrlForKey } from "./media";
import type { PrintTarget } from "@/lib/print-targets";
import { upscaleArtwork } from "@/pipeline/upscale";

export type UpscaleJob = { source?: unknown; target?: unknown; fallbackTarget?: unknown; posterFinish?: unknown };

function validTarget(value: unknown): value is PrintTarget {
  if (!value || typeof value !== "object") return false;
  const t = value as Record<string, unknown>;
  return ["minW", "minH", "targetW", "targetH"].every((key) => Number.isInteger(t[key]) && Number(t[key]) > 0 && Number(t[key]) <= 12000);
}

/** Tile sizes tried in order; smaller tiles cut ONNX activation memory roughly quadratically. */
export const TILE_LADDER = [256, 160, 96];

function isMemoryError(error: unknown) {
  return /memory|alloc|bad_alloc|ENOMEM|heap/i.test(error instanceof Error ? error.message : String(error));
}

export async function handleUpscaleJob(job: UpscaleJob, run: typeof upscaleArtwork = upscaleArtwork) {
  if (typeof job.source !== "string" || !job.source) throw new Error("source is required");
  if (!validTarget(job.target)) throw new Error("target {minW,minH,targetW,targetH} is required");
  if (job.fallbackTarget !== undefined && !validTarget(job.fallbackTarget)) throw new Error("fallbackTarget is invalid");
  const source = mediaUrlForKey(job.source);
  const started = Date.now();
  let peak = process.memoryUsage().rss;
  const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 250);
  try {
    let lastError: unknown;
    for (const tileSize of TILE_LADDER) {
      try {
        const result = await run(source, job.target, {
          fallbackTarget: job.fallbackTarget as PrintTarget | undefined,
          posterFinish: job.posterFinish === true,
          tileSize,
          skipWorker: true,
        });
        const key = result.url.match(/\/api\/media\/([^?#]+)/)?.[1] ?? null;
        const ms = Date.now() - started;
        console.log(`[upscaler] ${result.upscaleMethod} ${result.sourcePx.width}×${result.sourcePx.height} → ${result.outputPx.width}×${result.outputPx.height} in ${(ms / 1000).toFixed(1)}s tile=${tileSize} peakRss=${Math.round(peak / 1e6)}MB`);
        return { ...result, key: key ? decodeURIComponent(key) : null, ms, peakRssMb: Math.round(peak / 1e6), tileSize };
      } catch (error) {
        lastError = error;
        if (!isMemoryError(error)) throw error;
        console.warn(`[upscaler] tile ${tileSize} ran short of memory; retrying smaller`);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("upscale failed");
  } finally {
    clearInterval(sampler);
  }
}
