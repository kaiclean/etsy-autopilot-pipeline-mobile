import sharp from "sharp";
import { MAX_ARTWORK_BYTES } from "@/lib/object-storage";
import type { RgbImage } from "@/lib/png";

/** Enough for full-resolution print masters, with a bounded decoded allocation. */
export const MAX_ARTWORK_PIXELS = 64_000_000;
export const MAX_ARTWORK_EDGE = 16_000;
export type ArtworkFormat = "png" | "jpeg" | "webp";
export type ArtworkInfo = { width: number; height: number; format: ArtworkFormat };

function decoder(bytes: Buffer) {
  return sharp(bytes, { failOn: "warning", limitInputPixels: MAX_ARTWORK_PIXELS, animated: false })
    .timeout({ seconds: 15 });
}

/** Only static raster artwork is accepted; metadata alone is not proof that pixels decode. */
export async function inspectArtwork(bytes: Buffer): Promise<ArtworkInfo | null> {
  if (!bytes.length || bytes.length > MAX_ARTWORK_BYTES) return null;
  try {
    const meta = await decoder(bytes).metadata();
    if (!meta.format || !["png", "jpeg", "webp"].includes(meta.format) || (meta.pages ?? 1) !== 1) return null;
    const { width, height } = meta.autoOrient;
    if (!width || !height || width > MAX_ARTWORK_EDGE || height > MAX_ARTWORK_EDGE || width * height > MAX_ARTWORK_PIXELS) return null;
    return { width, height, format: meta.format as ArtworkFormat };
  } catch {
    return null;
  }
}

/** sRGB, EXIF-oriented, white-flattened RGB. Never modifies the original bytes. */
export async function decodeArtwork(bytes: Buffer, longEdge?: number): Promise<RgbImage | null> {
  if (longEdge !== undefined && (!Number.isInteger(longEdge) || longEdge < 1 || longEdge > MAX_ARTWORK_EDGE)) return null;
  if (!await inspectArtwork(bytes)) return null;
  try {
    let image = decoder(bytes).autoOrient().toColourspace("srgb").flatten({ background: "#ffffff" }).removeAlpha();
    if (longEdge) image = image.resize({ width: longEdge, height: longEdge, fit: "inside", withoutEnlargement: true });
    const { data, info } = await image.raw({ depth: "uchar" }).toBuffer({ resolveWithObject: true });
    if (info.channels !== 3 || data.length !== info.width * info.height * 3) return null;
    return { width: info.width, height: info.height, rgb: data };
  } catch {
    return null;
  }
}

export async function validateArtwork(bytes: Buffer): Promise<ArtworkInfo | null> {
  const info = await inspectArtwork(bytes);
  // A reduced decode still consumes/validates compressed image data without retaining a full RGB master.
  return info && await decodeArtwork(bytes, 32) ? info : null;
}
