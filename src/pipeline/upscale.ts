import sharp from "sharp";
import { config, storageBackend } from "@/lib/config";
import { loadArtworkBytes } from "@/lib/artwork-source";
import { uploadImageBytes } from "@/lib/object-storage";
import type { PixelSize, PrintTarget } from "@/lib/print-targets";
import { setUpscalerState, type UpscalerSource } from "@/lib/upscaler-status";

/** Box-hosted dashboards never perform model downloads, remote upscales, or local image inference. */
export function boxDashboardUpscaleBlocked() {
  return process.env.AUTOPILOT_EXECUTION === "box" && process.env.AUTOPILOT_BOX_WORKER !== "1";
}

function requireUpscaleWorker() {
  if (boxDashboardUpscaleBlocked()) throw new Error("Upscaling runs on the local box. Queue this job for the worker.");
}

type TensorLike = { data: Float32Array; dims: readonly number[] };
export type UpscaleSession = {
  inputNames: string[];
  outputNames: string[];
  run(input: Record<string, unknown>): Promise<Record<string, TensorLike>>;
};
type TensorFactory = (data: Float32Array, dims: number[]) => unknown;

export type UpscaledArtwork = {
  url: string;
  upscaleMethod: "realesrgan" | "lanczos" | "native";
  sourcePx: PixelSize;
  outputPx: PixelSize;
};

let sessionPromise: Promise<UpscaleSession | null> | undefined;
let lastFailure: string | null = null;

const MAX_MODEL_BYTES = 250 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

type ModelSource = { source: UpscalerSource; model: string | Uint8Array };

function fail(reason: string): null {
  lastFailure = reason;
  return null;
}

async function sha256File(file: string) {
  const { createHash } = await import("node:crypto");
  const { createReadStream } = await import("node:fs");
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(file).on("data", (chunk) => hash.update(chunk)).on("end", () => resolve()).on("error", reject);
  });
  return hash.digest("hex");
}

/** Downloads the ONNX model over HTTPS into tmp, verifying size and SHA-256. Returns the cached path or null. */
export async function downloadModel(url: string, sha256?: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  if (boxDashboardUpscaleBlocked()) return fail("model downloads run on the local box");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return fail("model URL is invalid");
  }
  if (parsed.protocol !== "https:") return fail("model URL must use HTTPS");
  if (sha256 && !/^[a-f0-9]{64}$/.test(sha256)) return fail("REALESRGAN_MODEL_SHA256 is not a 64-character hex digest");
  const os = await import("node:os");
  const path = await import("node:path");
  const fs = await import("node:fs/promises");
  const name = sha256 ?? (await import("node:crypto")).createHash("sha256").update(url).digest("hex").slice(0, 32);
  const cached = path.join(os.tmpdir(), `realesrgan-${name}.onnx`);
  try {
    await fs.access(cached);
    if (!sha256 || (await sha256File(cached)) === sha256) return cached;
    await fs.rm(cached, { force: true });
  } catch {
    // not cached yet
  }
  let response: Response;
  try {
    response = await fetchImpl(parsed.toString(), { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (error) {
    return fail(`model download error (${error instanceof Error ? error.name : "network"})`);
  }
  if (!response.ok || !response.body) return fail(`model download error (HTTP ${response.status})`);
  if (response.url && !response.url.startsWith("https:")) return fail("model download redirected away from HTTPS");
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_MODEL_BYTES) return fail("model exceeds the 250 MiB cap");
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256");
  const temp = `${cached}.${process.pid}.${Date.now()}.part`;
  const handle = await fs.open(temp, "w");
  let total = 0;
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_MODEL_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("oversize");
      }
      hash.update(value);
      await handle.write(value);
    }
  } catch (error) {
    await handle.close();
    await fs.rm(temp, { force: true });
    return fail(error instanceof Error && error.message === "oversize" ? "model exceeds the 250 MiB cap" : "model download error (stream)");
  }
  await handle.close();
  if (total === 0) {
    await fs.rm(temp, { force: true });
    return fail("model download was empty");
  }
  const digest = hash.digest("hex");
  if (sha256 && digest !== sha256) {
    await fs.rm(temp, { force: true });
    return fail("model hash mismatch");
  }
  await fs.rename(temp, cached);
  return cached;
}

async function modelSource(fetchImpl: typeof fetch = fetch): Promise<ModelSource | null> {
  if (boxDashboardUpscaleBlocked()) return fail("model loading runs on the local box");
  const { modelPath, modelKey, modelUrl, modelSha256 } = config.upscale;
  if (modelPath) {
    const fs = await import("node:fs/promises");
    try {
      await fs.access(modelPath);
      return { source: "path", model: modelPath };
    } catch {
      fail("REALESRGAN_MODEL_PATH file is missing");
    }
  }
  if (modelKey && storageBackend() === "s3" && /^[A-Za-z0-9._/-]{1,512}$/.test(modelKey) && !modelKey.split("/").includes("..")) {
    const { GetObjectCommand, S3Client } = await import("@aws-sdk/client-s3");
    const store = config.storage;
    const client = new S3Client({
      region: store.region,
      endpoint: store.endpoint,
      forcePathStyle: store.forcePathStyle,
      credentials: { accessKeyId: store.accessKeyId!, secretAccessKey: store.secretAccessKey! },
    });
    try {
      const response = await client.send(new GetObjectCommand({ Bucket: store.bucket, Key: modelKey }));
      if (response.ContentLength != null && response.ContentLength > MAX_MODEL_BYTES) {
        fail("S3 model exceeds the 250 MiB cap");
      } else {
        const bytes = await response.Body?.transformToByteArray();
        if (bytes && bytes.length > 0 && bytes.length <= MAX_MODEL_BYTES) return { source: "s3", model: bytes };
        fail("S3 model is empty or too large");
      }
    } catch (error) {
      fail(`S3 model read error (${error instanceof Error ? error.name : "unknown"})`);
    } finally {
      client.destroy();
    }
  } else if (modelKey) {
    fail("REALESRGAN_MODEL_KEY needs S3 storage and a safe key");
  }
  if (modelUrl) {
    const file = await downloadModel(modelUrl, modelSha256, fetchImpl);
    if (file) return { source: "url", model: file };
    return null;
  }
  if (!lastFailure) fail("no model source configured");
  return null;
}

/** Exposed for tests: resolves the model in PATH → S3 → URL order without creating an ORT session. */
export async function resolveModelSourceForTests(fetchImpl: typeof fetch) {
  lastFailure = null;
  const found = await modelSource(fetchImpl);
  return found ? { source: found.source, model: found.model } : { source: null, reason: lastFailure };
}

export async function loadRealEsrganSession(): Promise<UpscaleSession | null> {
  if (boxDashboardUpscaleBlocked()) return null;
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const started = Date.now();
      lastFailure = null;
      try {
        const found = await modelSource();
        if (!found) {
          console.warn(`[upscale] Real-ESRGAN unavailable: ${lastFailure ?? "unknown reason"}`);
          setUpscalerState({ state: "fallback", reason: lastFailure ?? "model unavailable" });
          return null;
        }
        const ort = await import("onnxruntime-node");
        const options = { executionProviders: ["cpu"], graphOptimizationLevel: "all" as const, enableCpuMemArena: false, enableMemPattern: false, intraOpNumThreads: Math.max(1, Math.min(8, (await import("node:os")).availableParallelism?.() ?? 4)) };
        const session = typeof found.model === "string"
          ? await ort.InferenceSession.create(found.model, options)
          : await ort.InferenceSession.create(found.model, options);
        const loadMs = Date.now() - started;
        const io = `${session.inputNames[0] ?? "?"}→${session.outputNames[0] ?? "?"}`;
        console.log(`[upscale] Real-ESRGAN loaded from ${found.source} in ${(loadMs / 1000).toFixed(1)}s (${io})`);
        setUpscalerState({ state: "ready", source: found.source, loadMs, io });
        return session as unknown as UpscaleSession;
      } catch (error) {
        const reason = `ORT error (${error instanceof Error ? error.message.slice(0, 160) : "unknown"})`;
        console.warn(`[upscale] Real-ESRGAN unavailable: ${reason}`);
        setUpscalerState({ state: "fallback", reason });
        return null;
      }
    })();
  }
  return sessionPromise;
}

export function setUpscaleSessionForTests(session: UpscaleSession | null | undefined) {
  sessionPromise = session === undefined ? undefined : Promise.resolve(session);
}

export async function upscaleTiledRgb(
  source: { data: Uint8Array; width: number; height: number; channels: number },
  session: UpscaleSession,
  tileSize = 256,
  overlap = 16,
  createTensor?: TensorFactory,
) {
  requireUpscaleWorker();
  if (source.channels !== 3 || tileSize < 1 || overlap < 0 || overlap >= tileSize) throw new Error("Invalid Real-ESRGAN tile input");
  const width = source.width * 4;
  const height = source.height * 4;
  const result = Buffer.alloc(width * height * 3);
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  if (!inputName || !outputName) throw new Error("Real-ESRGAN model has no input/output tensors");
  const tensorFactory = createTensor ?? (async () => {
    const ort = await import("onnxruntime-node");
    return (data: Float32Array, dims: number[]) => new ort.Tensor("float32", data, dims);
  })();
  const createInput = typeof tensorFactory === "function" ? tensorFactory : await tensorFactory;

  for (let top = 0; top < source.height; top += tileSize) {
    for (let left = 0; left < source.width; left += tileSize) {
      const right = Math.min(source.width, left + tileSize);
      const bottom = Math.min(source.height, top + tileSize);
      const tileLeft = Math.max(0, left - overlap);
      const tileTop = Math.max(0, top - overlap);
      const tileRight = Math.min(source.width, right + overlap);
      const tileBottom = Math.min(source.height, bottom + overlap);
      const tileWidth = tileRight - tileLeft;
      const tileHeight = tileBottom - tileTop;
      const tensor = new Float32Array(3 * tileWidth * tileHeight);
      for (let y = 0; y < tileHeight; y++) {
        for (let x = 0; x < tileWidth; x++) {
          const input = ((tileTop + y) * source.width + tileLeft + x) * 3;
          const offset = y * tileWidth + x;
          tensor[offset] = source.data[input]! / 255;
          tensor[tileWidth * tileHeight + offset] = source.data[input + 1]! / 255;
          tensor[2 * tileWidth * tileHeight + offset] = source.data[input + 2]! / 255;
        }
      }
      const output = await session.run({
        [inputName]: createInput(tensor, [1, 3, tileHeight, tileWidth]),
      });
      const image = output[outputName];
      if (!image || image.dims[1] !== 3 || image.dims[2] !== tileHeight * 4 || image.dims[3] !== tileWidth * 4) {
        throw new Error("Real-ESRGAN output tensor is not 4× RGB");
      }
      const plane = image.dims[2] * image.dims[3];
      const copyLeft = (left - tileLeft) * 4;
      const copyTop = (top - tileTop) * 4;
      for (let y = 0; y < (bottom - top) * 4; y++) {
        for (let x = 0; x < (right - left) * 4; x++) {
          const target = (((top * 4 + y) * width) + left * 4 + x) * 3;
          const sourceOffset = (copyTop + y) * image.dims[3] + copyLeft + x;
          result[target] = Math.max(0, Math.min(255, Math.round(image.data[sourceOffset]! * 255)));
          result[target + 1] = Math.max(0, Math.min(255, Math.round(image.data[plane + sourceOffset]! * 255)));
          result[target + 2] = Math.max(0, Math.min(255, Math.round(image.data[2 * plane + sourceOffset]! * 255)));
        }
      }
    }
  }
  return { data: result, width, height, channels: 3 as const };
}

export async function finalPng(bytes: Buffer, target: PrintTarget, raw?: { width: number; height: number; channels: 3 }, finish = false) {
  let image = sharp(bytes, {
    limitInputPixels: 128_000_000,
    ...(raw ? { raw } : {}),
  })
    .flatten({ background: "#ffffff" })
    .resize(target.targetW, target.targetH, { fit: "cover", kernel: "lanczos3" });
  // Poster finish: a 3px median removes upscale speckle, then a gentle unsharp mask restores edges.
  image = finish ? image.median(3).sharpen({ sigma: 0.8, m1: 0.5, m2: 1.5 }) : image.sharpen({ sigma: 0.5 });
  return image
    .withMetadata({ density: 300 })
    .toColourspace("srgb")
    .png({ compressionLevel: 9, palette: false })
    .toBuffer();
}

type WorkerOptions = { fallbackTarget?: PrintTarget; posterFinish?: boolean };

/** POSTs a job to the upscaler worker (Bearer UPSCALER_SECRET). Returns null-safe result or throws. */
export async function upscaleViaWorker(url: string, target: PrintTarget, options: WorkerOptions, fetchImpl: typeof fetch = fetch): Promise<UpscaledArtwork> {
  requireUpscaleWorker();
  const { workerUrl, workerSecret } = config.upscale;
  if (!workerUrl || !workerSecret) throw new Error("UPSCALER_URL or UPSCALER_SECRET is not set");
  const response = await fetchImpl(`${workerUrl.replace(/\/$/, "")}/upscale`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${workerSecret}` },
    body: JSON.stringify({ source: url, target, fallbackTarget: options.fallbackTarget, posterFinish: options.posterFinish ?? false }),
    signal: AbortSignal.timeout(20 * 60_000),
  });
  if (!response.ok) throw new Error(`worker HTTP ${response.status}`);
  const body = await response.json() as Partial<UpscaledArtwork>;
  const valid = (px: unknown): px is PixelSize => !!px && typeof px === "object" &&
    Number.isInteger((px as PixelSize).width) && Number.isInteger((px as PixelSize).height);
  if (typeof body.url !== "string" || !body.url || !valid(body.sourcePx) || !valid(body.outputPx) ||
    !["realesrgan", "lanczos", "native"].includes(String(body.upscaleMethod))) throw new Error("worker returned an invalid result");
  return { url: body.url, upscaleMethod: body.upscaleMethod!, sourcePx: body.sourcePx, outputPx: body.outputPx };
}

export async function upscaleArtwork(
  url: string,
  target: PrintTarget,
  options: { fallbackTarget?: PrintTarget; session?: UpscaleSession | null; createTensor?: TensorFactory; store?: boolean; posterFinish?: boolean; tileSize?: number; skipWorker?: boolean } = {},
): Promise<UpscaledArtwork> {
  requireUpscaleWorker();
  // Heavy upscales go to the dedicated worker when configured; any worker failure falls back to the local path.
  if (!options.skipWorker && options.session === undefined && options.store !== false && config.upscale.workerUrl && !config.upscale.isWorker) {
    const remote = await upscaleViaWorker(url, target, options).catch((error) => {
      console.warn(`[upscale] worker failed, using local path: ${error instanceof Error ? error.message.slice(0, 160) : "unknown error"}`);
      return null;
    });
    if (remote) return remote;
  }
  const sourceBytes = await loadArtworkBytes(url);
  if (!sourceBytes) throw new Error("Unable to read source artwork for upscaling");
  const metadata = await sharp(sourceBytes, { limitInputPixels: 64_000_000 }).metadata();
  if (!metadata.width || !metadata.height) throw new Error("Source artwork has no measurable dimensions");
  const sourcePx = { width: metadata.width, height: metadata.height };
  const outputTarget = options.fallbackTarget ?? target;
  const nativeFits = (metadata.width >= target.targetW && metadata.height >= target.targetH) ||
    (metadata.height >= target.targetW && metadata.width >= target.targetH);
  const needsUpscale = !nativeFits;
  let outputBytes: Buffer;
  let upscaleMethod: UpscaledArtwork["upscaleMethod"];
  const session = options.session === undefined ? await loadRealEsrganSession() : options.session;

  if (!needsUpscale) {
    outputBytes = await finalPng(sourceBytes, target);
    upscaleMethod = "native";
  } else if (session) {
    try {
      // Only feed Real-ESRGAN what a 4× pass needs: the output is resized to the target anyway, and this
      // keeps CPU time and memory bounded on small Railway instances.
      const needW = Math.ceil(target.targetW / 4);
      const needH = Math.ceil(target.targetH / 4);
      const shrink = metadata.width > needW * 1.05 && metadata.height > needH * 1.05;
      const input = await sharp(sourceBytes, { limitInputPixels: 64_000_000 })
        .resize(shrink ? { width: needW, height: needH, fit: "cover", kernel: "lanczos3" } : undefined)
        .flatten({ background: "#ffffff" })
        .toColourspace("srgb")
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const upscaled = await upscaleTiledRgb({
        data: input.data,
        width: input.info.width,
        height: input.info.height,
        channels: input.info.channels,
      }, session, options.tileSize ?? 256, 16, options.createTensor);
      outputBytes = await finalPng(upscaled.data, target, {
        width: upscaled.width,
        height: upscaled.height,
        channels: upscaled.channels,
      }, options.posterFinish ?? false);
      upscaleMethod = "realesrgan";
    } catch (error) {
      console.warn(`[upscale] Real-ESRGAN failed, falling back to lanczos: ${error instanceof Error ? error.message.slice(0, 160) : "unknown error"}`);
      outputBytes = await finalPng(sourceBytes, outputTarget);
      upscaleMethod = "lanczos";
    }
  } else {
    console.warn(`[upscale] Falling back to lanczos: ${lastFailure ?? "Real-ESRGAN session unavailable"}`);
    outputBytes = await finalPng(sourceBytes, outputTarget);
    upscaleMethod = "lanczos";
  }
  const stored = options.store === false ? null : await uploadImageBytes(outputBytes, "image/png");
  const storedUrl = stored?.url ?? `data:image/png;base64,${outputBytes.toString("base64")}`;
  const outputInfo = await sharp(outputBytes).metadata();
  if (!outputInfo.width || !outputInfo.height) throw new Error("Upscaled artwork could not be measured");
  return {
    url: storedUrl,
    upscaleMethod,
    sourcePx,
    outputPx: { width: outputInfo.width, height: outputInfo.height },
  };
}
