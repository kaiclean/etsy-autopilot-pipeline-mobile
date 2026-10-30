/**
 * Box-side pull loop: every 5 min (03:00–10:30 UTC, or always with --once/--now), ask the app for
 * designs needing Real-ESRGAN, upscale locally (one at a time), and POST the PNG back.
 * Env: APP_URL, UPSCALER_SECRET. Secrets are never logged.
 */
import { decodeDataUrl } from "@/lib/object-storage";
import type { PrintTarget } from "@/lib/print-targets";
import { handleUpscaleJob } from "./job";
import { upscaleArtwork } from "@/pipeline/upscale";

process.env.UPSCALER_ROLE = "worker";
const APP = (process.env.APP_URL ?? "https://etsy-autopilot-production-8b9f.up.railway.app").replace(/\/$/, "");
const SECRET = process.env.UPSCALER_SECRET ?? "";
const auth = { authorization: `Bearer ${SECRET}` };

export function inWindow(now = new Date()) {
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  return minutes >= 3 * 60 && minutes <= 10 * 60 + 30;
}

const CACHE = process.env.UPSCALER_CACHE ?? `${process.env.HOME ?? "/tmp"}/.cache/upscaler`;
export const MAX_ATTEMPTS = 3;
type Cached = { attempts: number; sourcePx: { width: number; height: number }; outputPx: { width: number; height: number } };

/** Presigned S3 PUT, then complete?key= (no image body through the app). Falls back to a body upload if S3 is absent. */
export async function report(designId: number, sourcePx: { width: number; height: number }, png: Buffer, fetchImpl: typeof fetch = fetch) {
  const query = new URLSearchParams({ designId: String(designId), method: "realesrgan", srcW: String(sourcePx.width), srcH: String(sourcePx.height) });
  // No silent fallback to a body upload: a presign failure is a loud failure.
  const signed = await fetchImpl(`${APP}/api/cron/upscale-jobs/upload-url?designId=${designId}`, { method: "POST", headers: auth, signal: AbortSignal.timeout(30_000) });
  if (!signed.ok) throw new Error(`presign failed HTTP ${signed.status}`);
  const { key, putUrl } = await signed.json() as { key: string; putUrl: string };
  const put = await fetchImpl(putUrl, { method: "PUT", headers: { "content-type": "image/png" }, body: new Uint8Array(png), signal: AbortSignal.timeout(300_000) });
  if (!put.ok) throw new Error(`S3 PUT failed HTTP ${put.status}`);
  query.set("key", key);
  // In hybrid hosting, validation and post-store image processing stay on the Mac.
  // Reuse the same signed upload-key binding, byte measurements, and quality gates as the HTTP handler.
  const completionUrl = `${APP}/api/cron/upscale-jobs/complete?${query}`;
  const completionInit = { method: "POST", headers: auth, signal: AbortSignal.timeout(300_000) };
  const done = process.env.AUTOPILOT_EXECUTION === "box" && process.env.AUTOPILOT_BOX_WORKER === "1"
    ? await (await import("../../src/app/api/cron/upscale-jobs/complete/route")).POST(new Request(completionUrl, completionInit))
    : await fetchImpl(completionUrl, completionInit);
  return { status: done.status, body: await done.json().catch(() => ({})) };
}

type Job = { designId: number; source: string; target: PrintTarget; fallbackTarget?: PrintTarget; posterFinish: boolean; reason: string };

export async function runOnce(limit = 3, saveTo?: string) {
  const res = await fetch(`${APP}/api/cron/upscale-jobs?limit=${limit}`, { headers: auth, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`list jobs HTTP ${res.status}`);
  const { jobs } = await res.json() as { jobs: Job[] };
  console.log(`[upscaler-pull] ${jobs.length} job(s)`);
  const results = [];
  const fs = await import("node:fs");
  const { createHash } = await import("node:crypto");
  fs.mkdirSync(CACHE, { recursive: true });
  for (const job of jobs) {
    const tag = `design-${job.designId}-${createHash("sha256").update(job.source).digest("hex").slice(0, 12)}`;
    const pngPath = `${CACHE}/${tag}.png`, metaPath = `${CACHE}/${tag}.json`;
    const state = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, "utf8")) as Cached : null;
    if (state && state.attempts >= MAX_ATTEMPTS) {
      console.warn(`[upscaler-pull] design #${job.designId}: ${state.attempts} failed reports, marked failed — skipping (no re-upscale)`);
      continue;
    }
    let png: Buffer;
    let meta: Cached;
    if (state && fs.existsSync(pngPath)) {
      png = fs.readFileSync(pngPath);
      meta = state;
      console.log(`[upscaler-pull] design #${job.designId}: reusing local upscale ${meta.outputPx.width}×${meta.outputPx.height} (attempt ${meta.attempts + 1}/${MAX_ATTEMPTS})`);
    } else {
      const result = await handleUpscaleJob(job, (url, target, options) => upscaleArtwork(url, target, { ...options, store: false }));
      if (result.upscaleMethod !== "realesrgan") {
        console.warn(`[upscaler-pull] design #${job.designId}: ${result.upscaleMethod}, not reporting`);
        continue;
      }
      const bytes = decodeDataUrl(result.url)?.bytes;
      if (!bytes) throw new Error("upscale output was not a data URL");
      // Light despeckle: 3px median on flat sky-like blocks only, before the file is cached/stored.
      const { despeckleFlatRegions } = await import("@/lib/despeckle");
      const clean = await despeckleFlatRegions(bytes);
      console.log(`[upscaler-pull] design #${job.designId} despeckle: median 3px on ${clean.flatBlocks}/${clean.totalBlocks} flat blocks`);
      png = clean.bytes;
      meta = { attempts: 0, sourcePx: result.sourcePx, outputPx: result.outputPx };
      fs.writeFileSync(pngPath, png);
      fs.writeFileSync(metaPath, JSON.stringify(meta));
      console.log(`[upscaler-pull] design #${job.designId} ${result.sourcePx.width}×${result.sourcePx.height} → ${result.outputPx.width}×${result.outputPx.height} in ${(result.ms / 1000).toFixed(1)}s peak ${result.peakRssMb}MB`);
    }
    if (saveTo && results.length === 0) fs.writeFileSync(saveTo, png);
    let status = 0;
    let body: unknown = {};
    try {
      ({ status, body } = await report(job.designId, meta.sourcePx, png));
    } catch (error) {
      body = { error: error instanceof Error ? error.message.slice(0, 200) : "report failed" };
      console.error(`[upscaler-pull] design #${job.designId} report FAILED: ${(body as { error: string }).error}`);
    }
    console.log(`[upscaler-pull] design #${job.designId} report → HTTP ${status}`);
    if (status >= 200 && status < 300) {
      fs.rmSync(pngPath, { force: true });
      fs.rmSync(metaPath, { force: true });
    } else {
      meta.attempts += 1;
      fs.writeFileSync(metaPath, JSON.stringify(meta));
      const reason = (body as { error?: string })?.error ?? `HTTP ${status}`;
      await fetch(`${APP}/api/cron/upscale-jobs/fail?${new URLSearchParams({ designId: String(job.designId), error: reason })}`, { method: "POST", headers: auth, signal: AbortSignal.timeout(30_000) })
        .catch(() => console.error(`[upscaler-pull] design #${job.designId}: could not record failure`));
    }
    results.push({ job, outputPx: meta.outputPx, status, body });
  }
  return results;
}

async function main() {
  process.env.AUTOPILOT_BOX_WORKER = "1";
  if (SECRET.length < 16) throw new Error("UPSCALER_SECRET missing");
  const args = process.argv.slice(2);
  const save = args.includes("--save") ? args[args.indexOf("--save") + 1] : undefined;
  if (args.includes("--once")) {
    console.log(JSON.stringify(await runOnce(Number(process.env.UPSCALER_LIMIT ?? 1), save), null, 1));
    return;
  }
  for (;;) {
    if (inWindow() || process.env.UPSCALER_ALWAYS === "1") {
      await runOnce().catch((error) => console.error(`[upscaler-pull] ${error instanceof Error ? error.message.slice(0, 200) : "error"}`));
    }
    await new Promise((resolve) => setTimeout(resolve, 5 * 60_000));
  }
}

if (process.argv[1]?.endsWith("pull.ts")) main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
