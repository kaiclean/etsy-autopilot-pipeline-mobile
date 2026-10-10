import { isPlaceholderUrl, isSafeArtworkUrl } from "@/lib/art-quality";
import { PRINT_HEIGHT, PRINT_WIDTH } from "@/lib/design-quality";
import { MAX_ARTWORK_BYTES, uploadImageBytes } from "@/lib/object-storage";
import { storageBackend } from "@/lib/config";
import { colorVariance, decodePng, encodeRgbPng, placeholderPng, previewPng, scaleToLongEdge, shrinkToLongEdge } from "@/lib/png";

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
 * Undersized PNGs are resampled to cover an A3 print at 300 dpi and stored on S3/Blob.
 * Without storage the original URL and its real dimensions are kept, and the gate holds the draft.
 */
export async function preparePrintFile(url: string, opts?: { upload?: typeof uploadImageBytes; print?: boolean }): Promise<PreparedArt> {
  const bytes = await loadImageBytes(url);
  const image = bytes ? decodePng(bytes) : null;
  if (!image) return { url, width: null, height: null, variance: null };
  const variance = Math.round(colorVariance(image) * 10) / 10;
  const previewBytes = encodeRgbPng(shrinkToLongEdge(image, 512));
  const visionPreview = previewBytes.length < 2_000_000 ? `data:image/png;base64,${previewBytes.toString("base64")}` : undefined;
  const measured = { url, width: image.width, height: image.height, variance, visionPreview };
  if (opts?.print === false) return measured;
  const long = Math.max(image.width, image.height);
  const short = Math.min(image.width, image.height);
  if (isPlaceholderUrl(url) || (long >= PRINT_HEIGHT && short >= PRINT_WIDTH) || (!opts?.upload && storageBackend() === "none")) {
    return measured;
  }
  const edge = Math.ceil(long * Math.max(PRINT_WIDTH / short, PRINT_HEIGHT / long));
  if (edge > 8000 || Math.ceil(image.width * edge / long) * Math.ceil(image.height * edge / long) > 25_000_000) {
    return measured;
  }
  const scaled = scaleToLongEdge(image, edge);
  const stored = await (opts?.upload ?? uploadImageBytes)(encodeRgbPng(scaled), "image/png");
  if (!stored) return measured;
  return { ...measured, url: stored.url, width: scaled.width, height: scaled.height };
}
