import sharp from "sharp";
import { ETSY_FILE_LIMITS, PRINT_DPI, PRINT_SPECS, type PrintSpec } from "./deliverables";

export type RenderedFile = {
  spec: PrintSpec;
  name: string;
  bytes: Buffer;
  width: number;
  height: number;
  quality: number;
  /** Enlargement from `src` to this file. */
  upscale: number;
};

const QUALITIES = [92, 88, 84, 80, 76, 72] as const;

function fileName(spec: PrintSpec, width: number, height: number) {
  const slug = spec.ratio === "ISO A" ? "iso-a3" : spec.ratio.replace(":", "x").toLowerCase();
  return `print-${slug}-${width}x${height}.jpg`;
}

/**
 * Crops the artwork to each wall-art ratio (saliency-aware, so the subject stays in frame),
 * resamples it to the 300 DPI pixel size and encodes a JPG with 300 DPI metadata.
 * `scale` shrinks every target, for tests and previews only.
 */
export async function renderPrintPack(
  src: Buffer,
  opts: { scale?: number; maxBytes?: number; specs?: readonly PrintSpec[] } = {},
): Promise<RenderedFile[]> {
  const scale = opts.scale ?? 1;
  const maxBytes = Math.min(opts.maxBytes ?? ETSY_FILE_LIMITS.maxBytes, ETSY_FILE_LIMITS.maxBytes);
  const meta = await sharp(src).metadata();
  if (!meta.width || !meta.height) throw new Error("Artwork has no readable size");
  const out: RenderedFile[] = [];
  for (const spec of opts.specs ?? PRINT_SPECS) {
    const width = Math.round(spec.width * scale);
    const height = Math.round(spec.height * scale);
    const base = sharp(src)
      .rotate()
      .resize(width, height, { fit: "cover", position: sharp.strategy.attention, kernel: "lanczos3" })
      .flatten({ background: "#ffffff" })
      .withMetadata({ density: PRINT_DPI });
    let bytes: Buffer | null = null;
    let quality = 0;
    for (const q of QUALITIES) {
      const candidate = await base.clone().jpeg({ quality: q, mozjpeg: true, chromaSubsampling: "4:4:4" }).toBuffer();
      if (candidate.length <= maxBytes) {
        bytes = candidate;
        quality = q;
        break;
      }
    }
    if (!bytes) throw new Error(`${spec.ratio} file does not fit the ${maxBytes} byte limit even at JPEG quality ${QUALITIES.at(-1)}`);
    out.push({
      spec,
      name: fileName(spec, width, height),
      bytes,
      width,
      height,
      quality,
      upscale: Math.max(width / meta.width, height / meta.height),
    });
  }
  return out;
}
