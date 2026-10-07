import { isPlaceholderUrl, isSafeArtworkUrl, MIN_PRINT_EDGE } from "@/lib/art-quality";
import { uploadImageBytes } from "@/lib/object-storage";
import { colorVariance, decodePng, encodeRgbPng, placeholderPng, previewPng, scaleToLongEdge } from "@/lib/png";

export const PRINT_LONG_EDGE = 2048;

export type PreparedArt = {
  url: string;
  width: number | null;
  height: number | null;
  variance: number | null;
};

async function loadImageBytes(url: string): Promise<Buffer | null> {
  if (url.startsWith("data:")) {
    const comma = url.indexOf(",");
    if (comma < 0) return null;
    const meta = url.slice(0, comma);
    const payload = url.slice(comma + 1);
    return Buffer.from(payload, /;base64/i.test(meta) ? "base64" : "utf8");
  }
  const local = placeholderPng(url) ?? previewPng(url);
  if (local) return local;
  if (!isSafeArtworkUrl(url)) return null;
  const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(15000) });
  if (!res.ok) return null;
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0 || bytes.length > 15_000_000) return null;
  return bytes;
}

/**
 * Measure a generated print file. Placeholder URLs are left as-is so the gate can reject them.
 * A decoded PNG under 2000px is scaled to a 2048 long edge and stored on S3/Blob when storage exists.
 * Without storage the original URL and its real dimensions are kept, and the gate holds the draft.
 */
export async function preparePrintFile(url: string): Promise<PreparedArt> {
  const bytes = await loadImageBytes(url);
  const image = bytes ? decodePng(bytes) : null;
  if (!image) return { url, width: null, height: null, variance: null };
  const variance = Math.round(colorVariance(image) * 10) / 10;
  const long = Math.max(image.width, image.height);
  if (isPlaceholderUrl(url) || long >= MIN_PRINT_EDGE) {
    return { url, width: image.width, height: image.height, variance };
  }
  const scaled = scaleToLongEdge(image, PRINT_LONG_EDGE);
  const stored = await uploadImageBytes(encodeRgbPng(scaled), "image/png");
  if (!stored) return { url, width: image.width, height: image.height, variance };
  return { url: stored.url, width: scaled.width, height: scaled.height, variance };
}
