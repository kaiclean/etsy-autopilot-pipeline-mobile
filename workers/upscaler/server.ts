/**
 * Dedicated Real-ESRGAN upscaler worker. One job at a time, tiled ONNX inference,
 * falls back to smaller tiles if memory runs short. Auth: Bearer UPSCALER_SECRET.
 * POST /upscale { source: url | "s3:<key>" | media key, target, fallbackTarget?, posterFinish? }
 * → { url, key, upscaleMethod, sourcePx, outputPx, ms, peakRssMb, tileSize }
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { handleUpscaleJob, type UpscaleJob } from "./job";

process.env.UPSCALER_ROLE = "worker";
const secret = process.env.UPSCALER_SECRET ?? "";
const port = Number(process.env.PORT ?? 8080);
const MAX_BODY = 80 * 1024 * 1024;
let queue: Promise<unknown> = Promise.resolve();
let busy = 0;

function authorized(req: IncomingMessage) {
  const given = Buffer.from(req.headers.authorization ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return secret.length >= 16 && given.length === want.length && timingSafeEqual(given, want);
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true, busy, rssMb: Math.round(process.memoryUsage().rss / 1e6) });
  if (req.method !== "POST" || req.url !== "/upscale") return send(res, 404, { error: "not found" });
  if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
  let job: UpscaleJob;
  try {
    job = await readJson(req) as UpscaleJob;
  } catch {
    return send(res, 400, { error: "invalid JSON" });
  }
  busy++;
  const run = queue.then(() => handleUpscaleJob(job));
  queue = run.catch(() => undefined);
  try {
    send(res, 200, await run);
  } catch (error) {
    send(res, 422, { error: error instanceof Error ? error.message.slice(0, 200) : "upscale failed" });
  } finally {
    busy--;
  }
}).listen(port, "::", () => console.log(`[upscaler] listening on [::]:${port}`));
