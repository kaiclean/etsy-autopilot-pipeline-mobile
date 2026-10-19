import sharp from "sharp";
import { config, storageBackend } from "@/lib/config";
import { loadArtworkBytes } from "@/lib/artwork-source";
import { uploadImageBytes } from "@/lib/object-storage";
import type { PixelSize, PrintTarget } from "@/lib/print-targets";

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

async function modelBytes(): Promise<string | Uint8Array | null> {
  const { modelPath, modelKey } = config.upscale;
  if (modelPath) {
    const fs = await import("node:fs/promises");
    try {
      await fs.access(modelPath);
      return modelPath;
    } catch {
      return null;
    }
  }
  if (!modelKey || storageBackend() !== "s3" || !/^[A-Za-z0-9._/-]{1,512}$/.test(modelKey) || modelKey.split("/").includes("..")) return null;
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
    if (response.ContentLength != null && response.ContentLength > 250 * 1024 * 1024) return null;
    const bytes = await response.Body?.transformToByteArray();
    return bytes && bytes.length > 0 && bytes.length <= 250 * 1024 * 1024 ? bytes : null;
  } finally {
    client.destroy();
  }
}

export async function loadRealEsrganSession(): Promise<UpscaleSession | null> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      try {
        const model = await modelBytes();
        if (!model) return null;
        const ort = await import("onnxruntime-node");
        const session = typeof model === "string"
          ? await ort.InferenceSession.create(model, {
            executionProviders: ["cpu"],
            graphOptimizationLevel: "all",
          })
          : await ort.InferenceSession.create(model, {
          executionProviders: ["cpu"],
          graphOptimizationLevel: "all",
          });
        return session as unknown as UpscaleSession;
      } catch {
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

async function finalPng(bytes: Buffer, target: PrintTarget, raw?: { width: number; height: number; channels: 3 }) {
  return sharp(bytes, {
    limitInputPixels: 64_000_000,
    ...(raw ? { raw } : {}),
  })
    .flatten({ background: "#ffffff" })
    .resize(target.targetW, target.targetH, { fit: "cover", kernel: "lanczos3" })
    .sharpen({ sigma: 0.5 })
    .withMetadata({ density: 300 })
    .toColourspace("srgb")
    .png({ compressionLevel: 9, effort: 8 })
    .toBuffer();
}

export async function upscaleArtwork(
  url: string,
  target: PrintTarget,
  options: { fallbackTarget?: PrintTarget; session?: UpscaleSession | null; createTensor?: TensorFactory; store?: boolean } = {},
): Promise<UpscaledArtwork> {
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
      const input = await sharp(sourceBytes, { limitInputPixels: 64_000_000 })
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
      }, session, 256, 16, options.createTensor);
      outputBytes = await finalPng(upscaled.data, target, {
        width: upscaled.width,
        height: upscaled.height,
        channels: upscaled.channels,
      });
      upscaleMethod = "realesrgan";
    } catch {
      outputBytes = await finalPng(sourceBytes, outputTarget);
      upscaleMethod = "lanczos";
    }
  } else {
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
