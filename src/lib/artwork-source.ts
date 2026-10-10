import { isPlaceholderUrl, isSafeArtworkUrl } from "@/lib/art-quality";
import { decodeDataUrl, MEDIA_KEY, readStoredObject } from "@/lib/object-storage";
import { decodePng, encodeRgbPng, shrinkToLongEdge, type RgbImage } from "@/lib/png";

const MAX_BYTES = 15_000_000;
/** Gallery previews stay well under the 2048px print file so the deliverable is not given away. */
export const PREVIEW_LONG_EDGE = 1200;

/** Object key when `url` points at this app's `/api/media/<key>` route. */
export function ownMediaKey(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url, "http://localhost");
  } catch {
    return null;
  }
  const marker = "/api/media/";
  const at = parsed.pathname.indexOf(marker);
  if (at < 0) return null;
  let key: string;
  try {
    key = decodeURIComponent(parsed.pathname.slice(at + marker.length));
  } catch {
    return null;
  }
  return MEDIA_KEY.test(key) ? key : null;
}

/**
 * Raw bytes of generated artwork. Reads `data:` URLs and this app's own S3 objects directly,
 * so neither the server nor Printify has to fetch a localhost or inline URL. Other URLs must be public https.
 */
export async function loadArtworkBytes(src: string, fetchImpl: typeof fetch = fetch): Promise<Buffer | null> {
  if (!src) return null;
  if (src.startsWith("data:")) {
    const decoded = decodeDataUrl(src);
    return decoded && decoded.bytes.length <= MAX_BYTES ? decoded.bytes : null;
  }
  const key = ownMediaKey(src);
  if (key) {
    const stored = await readStoredObject(key).catch(() => null);
    if (stored) return Buffer.from(stored.bytes);
  }
  if (!isSafeArtworkUrl(src)) return null;
  try {
    const res = await fetchImpl(src, { redirect: "error", signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    return bytes.length > 0 && bytes.length <= MAX_BYTES ? bytes : null;
  } catch {
    return null;
  }
}

/** Decoded real artwork. Placeholder, mockup, and preview URLs are not artwork and return null. */
export async function loadArtworkImage(src: string | null | undefined, fetchImpl: typeof fetch = fetch): Promise<RgbImage | null> {
  if (!src || isPlaceholderUrl(src) || src.includes("/api/mockup/") || src.includes("/api/preview")) return null;
  const bytes = await loadArtworkBytes(src, fetchImpl);
  return bytes ? decodePng(bytes) : null;
}

/** True for this app's `/api/preview` gallery URLs. */
export function isPreviewUrl(url: string) {
  try {
    return new URL(url, "http://localhost").pathname.endsWith("/api/preview");
  } catch {
    return false;
  }
}

/**
 * Downscaled render of the real artwork behind a `/api/preview?src=…` URL.
 * Returns null when the URL has no loadable artwork (missing `src`, placeholder art, or an unreachable file).
 */
export async function renderArtworkPreview(previewUrl: string, fetchImpl: typeof fetch = fetch): Promise<Buffer | null> {
  if (!isPreviewUrl(previewUrl)) return null;
  const src = new URL(previewUrl, "http://localhost").searchParams.get("src");
  const image = await loadArtworkImage(src, fetchImpl);
  if (!image) return null;
  const long = Math.max(image.width, image.height);
  const edge = Math.min(PREVIEW_LONG_EDGE, Math.max(1, Math.round(long * 0.6)));
  return encodeRgbPng(shrinkToLongEdge(image, edge));
}
