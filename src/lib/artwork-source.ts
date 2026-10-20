import { isPlaceholderUrl, isSafeArtworkUrl } from "@/lib/art-quality";
import { decodeArtwork, inspectArtwork } from "@/lib/artwork-codec";
import { decodeDataUrl, MAX_ARTWORK_BYTES, MEDIA_KEY, readStoredObject } from "@/lib/object-storage";
import { encodeRgbPng, shrinkToLongEdge, type RgbImage } from "@/lib/png";

const MAX_BYTES = MAX_ARTWORK_BYTES;
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
/** Short-lived in-process cache so one request that just stored a file does not re-read it from S3 (≈10 s per 25 MB). */
const primed = new Map<string, { bytes: Buffer; until: number }>();
export function primeArtworkBytes(url: string, bytes: Buffer, ttlMs = 10 * 60_000) {
  const now = Date.now();
  for (const [key, row] of primed) if (row.until < now) primed.delete(key);
  primed.set(url, { bytes, until: now + ttlMs });
}

export async function loadArtworkBytes(src: string, fetchImpl: typeof fetch = fetch): Promise<Buffer | null> {
  if (!src) return null;
  const hit = primed.get(src);
  if (hit && hit.until >= Date.now()) return hit.bytes;
  if (src.startsWith("data:")) {
    // Bound the encoded input before the data URL parser allocates its decoded buffer.
    if (src.length > MAX_BYTES * 4 / 3 + 1024) return null;
    try {
      const decoded = decodeDataUrl(src);
      return decoded && decoded.bytes.length <= MAX_BYTES ? decoded.bytes : null;
    } catch {
      return null;
    }
  }
  const key = ownMediaKey(src);
  if (key) {
    const stored = await readStoredObject(key).catch(() => null);
    if (stored && stored.bytes.length > 0 && stored.bytes.length <= MAX_BYTES) return Buffer.from(stored.bytes);
  }
  if (!isSafeArtworkUrl(src)) return null;
  try {
    const res = await fetchImpl(src, { redirect: "error", signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    return await readCappedArtworkBody(res, MAX_BYTES);
  } catch {
    return null;
  }
}

export async function readCappedArtworkBody(res: Response, maxBytes = MAX_BYTES): Promise<Buffer | null> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) return null;
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  const reader = res.body?.getReader();
  if (!reader) {
    const bytes = Buffer.from(await res.arrayBuffer());
    return bytes.length > 0 && bytes.length <= maxBytes ? bytes : null;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return total ? Buffer.concat(chunks, total) : null;
}

/** Decoded real artwork. Placeholder, mockup, and preview URLs are not artwork and return null. */
export async function loadArtworkImage(src: string | null | undefined, fetchImpl: typeof fetch = fetch): Promise<RgbImage | null> {
  if (!src || isPlaceholderUrl(src) || src.includes("/api/mockup/") || src.includes("/api/preview")) return null;
  const bytes = await loadArtworkBytes(src, fetchImpl);
  return bytes ? decodeArtwork(bytes) : null;
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
  if (!src || isPlaceholderUrl(src) || src.includes("/api/mockup/") || src.includes("/api/preview")) return null;
  const bytes = await loadArtworkBytes(src, fetchImpl);
  return bytes ? renderArtworkPreviewBytes(bytes) : null;
}

export async function renderArtworkPreviewBytes(bytes: Buffer): Promise<Buffer | null> {
  const info = await inspectArtwork(bytes);
  if (!info) return null;
  const edge = Math.min(PREVIEW_LONG_EDGE, Math.max(1, Math.round(Math.max(info.width, info.height) * 0.6)));
  const image = await decodeArtwork(bytes, edge);
  if (!image) return null;
  return encodeRgbPng(shrinkToLongEdge(image, edge));
}
