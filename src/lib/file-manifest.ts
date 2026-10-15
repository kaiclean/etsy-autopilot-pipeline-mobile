import { createHash } from "node:crypto";
import type { FileManifest } from "@/db/schema";
import { isPlaceholderUrl } from "./art-quality";
import { MAX_ARTWORK_EDGE, MAX_ARTWORK_PIXELS, validateArtwork, type ArtworkFormat } from "./artwork-codec";
import { isPreviewUrl, readCappedArtworkBody, renderArtworkPreviewBytes } from "./artwork-source";
import type { ArtworkProvenance } from "./artwork-provenance";
import { config, publicAppUrl } from "./config";
import { decodeDataUrl, MAX_ARTWORK_BYTES, MEDIA_KEY, readStoredObject } from "./object-storage";
import { decodePng, localAssetPng } from "./png";

/** Same ceiling as object storage. Larger responses are not hashed. */
export const MANIFEST_MAX_BYTES = MAX_ARTWORK_BYTES;

export type ManifestLoadDeps = {
  fetchImpl?: typeof fetch;
  readObject?: (key: string) => Promise<{ bytes: Uint8Array } | null>;
  maxBytes?: number;
  provenance?: ArtworkProvenance;
};

export function inspectPng(png: Buffer, filename: string): FileManifest["delivery"] | null {
  if (png.length > MANIFEST_MAX_BYTES) return null;
  let image;
  try {
    image = decodePng(png);
  } catch {
    return null;
  }
  if (!image) return null;
  const { width, height } = image;
  return {
    filename,
    width,
    height,
    bytes: png.length,
    sha256: createHash("sha256").update(png).digest("hex"),
  };
}

function bytesFor(url: string): Buffer | null {
  if (url.length > MANIFEST_MAX_BYTES * 4 / 3 + 1024) return null;
  if (isPreviewUrl(url) && new URL(url, "http://localhost").searchParams.has("src")) return null;
  const local = localAssetPng(url);
  if (local) return local;
  try {
    const data = decodeDataUrl(url);
    if (!data || data.bytes.length > MANIFEST_MAX_BYTES) return null;
    return data.bytes;
  } catch {
    return null;
  }
}

function filenameFor(url: string, fallback: string) {
  try {
    const parsed = new URL(url, "http://localhost");
    const base = parsed.pathname.split("/").filter(Boolean).pop();
    if (base && base.includes(".")) return base.slice(0, 80);
  } catch {
    // data URLs and odd strings fall through
  }
  return fallback;
}

function assembleManifest(deliveryUrl: string, previewUrl: string, delivery: Buffer | null, previewBytes: Buffer | null): FileManifest | null {
  if (!delivery) return null;
  const deliveryFile = inspectPng(delivery, filenameFor(deliveryUrl, "artwork.png"));
  if (!deliveryFile) return null;
  const preview = previewBytes ? inspectPng(previewBytes, filenameFor(previewUrl, "preview.png")) : null;
  if (preview && preview.sha256 === deliveryFile.sha256) return null;
  return { delivery: deliveryFile, ...(preview ? { preview } : {}) };
}

/** Reads local or data-URL bytes. Remote http files are left unrecorded so publish cannot invent a hash. */
export function tryBuildFileManifest(deliveryUrl: string, previewUrl: string): FileManifest | null {
  return assembleManifest(deliveryUrl, previewUrl, bytesFor(deliveryUrl), bytesFor(previewUrl));
}

/** Object key for `/api/media/<key>` or a URL under S3_PUBLIC_BASE_URL. */
export function storageKeyFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url, "http://localhost");
    const marker = "/api/media/";
    const at = parsed.pathname.indexOf(marker);
    if (at >= 0) {
      const key = decodeURIComponent(parsed.pathname.slice(at + marker.length));
      return MEDIA_KEY.test(key) ? key : null;
    }
  } catch {
    return null;
  }
  const base = config.storage.publicBaseUrl;
  if (!base || !(url === base || url.startsWith(`${base}/`))) return null;
  const key = url.slice(base.length).replace(/^\//, "").split("?")[0] ?? "";
  return MEDIA_KEY.test(key) ? key : null;
}

function ownOriginHttpUrl(url: string): string | null {
  if (!/^https?:\/\//i.test(url)) {
    if (!url.startsWith("/api/media/")) return null;
    return new URL(url, `${publicAppUrl()}/`).toString();
  }
  try {
    const parsed = new URL(url);
    const origin = new URL(publicAppUrl());
    if (parsed.origin !== origin.origin) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

async function fetchCapped(url: string, fetchImpl: typeof fetch, maxBytes: number): Promise<Buffer | null> {
  const res = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return null;
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  const buf = await readCappedArtworkBody(res, maxBytes);
  if (!buf || buf.length === 0) return null;
  return buf;
}

/** A storage or network error means "no bytes", like a missing file, so callers never throw on an unreadable file. */
async function loadArtworkBytes(url: string, deps: ManifestLoadDeps): Promise<Buffer | null> {
  const maxBytes = deps.maxBytes ?? MANIFEST_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MANIFEST_MAX_BYTES) return null;
  // The route renders real source art. Never hash its synthetic fallback as if it were that preview.
  if (isPreviewUrl(url)) {
    const src = new URL(url, "http://localhost").searchParams.get("src");
    if (src) {
      if (isPreviewUrl(src) || isPlaceholderUrl(src) || src.includes("/api/mockup/")) return null;
      const artwork = await loadArtworkBytes(src, deps);
      const preview = artwork ? await renderArtworkPreviewBytes(artwork) : null;
      return preview && preview.length <= maxBytes ? preview : null;
    }
  }
  const local = bytesFor(url);
  if (local) return local.length <= maxBytes ? local : null;
  const key = storageKeyFromUrl(url);
  if (key) {
    let object: { bytes: Uint8Array } | null = null;
    try {
      object = await (deps.readObject ?? readStoredObject)(key);
    } catch {
      object = null;
    }
    if (object?.bytes) {
      const buf = Buffer.from(object.bytes);
      if (buf.length > 0 && buf.length <= maxBytes) return buf;
    }
  }
  const remote = ownOriginHttpUrl(url);
  if (!remote) return null;
  try {
    return await fetchCapped(remote, deps.fetchImpl ?? fetch, maxBytes);
  } catch {
    return null;
  }
}

/**
 * Filename, pixel size, bytes, and sha256 for a real delivery file.
 * `/api/media/<key>` is read with S3 GetObject. Other URLs are fetched only from this app's origin, with a size cap.
 */
export async function buildFileManifest(
  deliveryUrl: string,
  previewUrl: string,
  deps: ManifestLoadDeps = {},
): Promise<ArtworkManifest | null> {
  const delivery = await loadArtworkBytes(deliveryUrl, deps);
  const preview = await loadArtworkBytes(previewUrl, deps);
  if (!delivery) return null;
  const deliveryFile = await inspectArtworkFile(delivery, filenameFor(deliveryUrl, "artwork"));
  if (!deliveryFile) return null;
  const previewFile = preview ? await inspectArtworkFile(preview, filenameFor(previewUrl, "preview")) : null;
  if (previewFile?.sha256 === deliveryFile.sha256) return null;
  return { version: 1, delivery: deliveryFile, ...(previewFile ? { preview: previewFile } : {}),
    ...(deps.provenance ? { provenance: deps.provenance } : {}) };
}

export type ArtworkFileRecord = FileManifest["delivery"] & { format: ArtworkFormat; colourSpace: "srgb" | "source" };
export type ArtworkManifest = FileManifest & { version: 1; provenance?: ArtworkProvenance };

/** Hashes the original delivery bytes, not a re-encoded or downscaled substitute. */
export async function inspectArtworkFile(bytes: Buffer, filename: string): Promise<ArtworkFileRecord | null> {
  const info = await validateArtwork(bytes);
  if (!info) return null;
  const extension = info.format === "jpeg" ? "jpg" : info.format;
  return {
    filename: filename.includes(".") ? filename : `${filename}.${extension}`,
    width: info.width,
    height: info.height,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    format: info.format,
    // Original files retain their original colour profile; RGB normalization is for derived assets.
    colourSpace: "source",
  };
}

export function manifestIsComplete(manifest: FileManifest | null | undefined) {
  const file = manifest?.delivery;
  if (!file) return false;
  return Boolean(
    file.filename &&
      Number.isSafeInteger(file.width) && file.width > 0 && file.width <= MAX_ARTWORK_EDGE &&
      Number.isSafeInteger(file.height) && file.height > 0 && file.height <= MAX_ARTWORK_EDGE &&
      file.width * file.height <= MAX_ARTWORK_PIXELS &&
      Number.isSafeInteger(file.bytes) && file.bytes > 0 && file.bytes <= MANIFEST_MAX_BYTES &&
      /^[a-f0-9]{64}$/.test(file.sha256),
  );
}
