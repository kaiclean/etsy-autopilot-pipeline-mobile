import { isSafeArtworkUrl } from "@/lib/art-quality";
import { MAX_ARTWORK_BYTES } from "@/lib/object-storage";
import { colorVariance, decodePng, encodeRgbPng, placeholderPng, previewPng, shrinkToLongEdge } from "@/lib/png";

export type PreparedArt = {
  url: string;
  width: number | null;
  height: number | null;
  variance: number | null;
  visionPreview?: string;
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
  if (bytes.length === 0 || bytes.length > MAX_ARTWORK_BYTES) return null;
  return bytes;
}

/**
 * Measure a generated print file. Placeholder URLs are left as-is so the gate can reject them.
 * Print output is upscaled by the image provider; this measures its actual dimensions.
 */
export async function preparePrintFile(url: string): Promise<PreparedArt> {
  const bytes = await loadImageBytes(url);
  const image = bytes ? decodePng(bytes) : null;
  if (!image) return { url, width: null, height: null, variance: null };
  const variance = Math.round(colorVariance(image) * 10) / 10;
  const previewBytes = encodeRgbPng(shrinkToLongEdge(image, 512));
  const visionPreview = previewBytes.length < 2_000_000 ? `data:image/png;base64,${previewBytes.toString("base64")}` : undefined;
  return { url, width: image.width, height: image.height, variance, visionPreview };
}
