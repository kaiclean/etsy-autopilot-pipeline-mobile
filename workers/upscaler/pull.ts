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

type Job = { designId: number; source: string; target: PrintTarget; fallbackTarget?: PrintTarget; posterFinish: boolean; reason: string };

export async function runOnce(limit = 3, saveTo?: string) {
  const res = await fetch(`${APP}/api/cron/upscale-jobs?limit=${limit}`, { headers: auth, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`list jobs HTTP ${res.status}`);
  const { jobs } = await res.json() as { jobs: Job[] };
  console.log(`[upscaler-pull] ${jobs.length} job(s)`);
  const results = [];
  for (const job of jobs) {
    const result = await handleUpscaleJob(job, (url, target, options) => upscaleArtwork(url, target, { ...options, store: false }));
    if (result.upscaleMethod !== "realesrgan") {
      console.warn(`[upscaler-pull] design #${job.designId}: ${result.upscaleMethod}, not reporting`);
      continue;
    }
    const png = decodeDataUrl(result.url)?.bytes;
    if (!png) throw new Error("upscale output was not a data URL");
    if (saveTo && results.length === 0) (await import("node:fs")).writeFileSync(saveTo, png);
    const query = new URLSearchParams({ designId: String(job.designId), method: "realesrgan", srcW: String(result.sourcePx.width), srcH: String(result.sourcePx.height) });
    const done = await fetch(`${APP}/api/cron/upscale-jobs/complete?${query}`, {
      method: "POST", headers: { ...auth, "content-type": "image/png" }, body: new Uint8Array(png), signal: AbortSignal.timeout(300_000),
    });
    const body = await done.json().catch(() => ({}));
    console.log(`[upscaler-pull] design #${job.designId} ${result.sourcePx.width}×${result.sourcePx.height} → ${result.outputPx.width}×${result.outputPx.height} in ${(result.ms / 1000).toFixed(1)}s peak ${result.peakRssMb}MB → HTTP ${done.status}`);
    results.push({ job, result: { ...result, url: undefined }, status: done.status, body });
  }
  return results;
}

async function main() {
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
