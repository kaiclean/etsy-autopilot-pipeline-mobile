import { createHash } from "node:crypto";
import type { FileManifest } from "@/db/schema";
import { config, publicAppUrl } from "./config";
import { decodeDataUrl, MAX_ARTWORK_BYTES, MEDIA_KEY, readStoredObject } from "./object-storage";
import { localAssetPng } from "./png";

/** Same ceiling as object storage. Larger responses are not hashed. */
export const MANIFEST_MAX_BYTES = MAX_ARTWORK_BYTES;

export type ManifestLoadDeps = {
  fetchImpl?: typeof fetch;
  readObject?: (key: string) => Promise<{ bytes: Uint8Array } | null>;
  maxBytes?: number;
};

export function inspectPng(png: Buffer, filename: string): FileManifest["delivery"] | null {
  if (png.length < 24 || png[0] !== 0x89 || png.toString("ascii", 12, 16) !== "IHDR") return null;
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (!width || !height) return null;
  return {
    filename,
    width,
    height,
    bytes: png.length,
    sha256: createHash("sha256").update(png).digest("hex"),
  };
}

function bytesFor(url: string): Buffer | null {
  const local = localAssetPng(url);
  if (local) return local;
  const data = decodeDataUrl(url);
  if (!data) return null;
  return data.bytes;
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

async function readCappedBody(res: Response, maxBytes: number): Promise<Buffer | null> {
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > maxBytes ? null : buf;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

async function fetchCapped(url: string, fetchImpl: typeof fetch, maxBytes: number): Promise<Buffer | null> {
  const res = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return null;
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  const buf = await readCappedBody(res, maxBytes);
  if (!buf || buf.length === 0) return null;
  return buf;
}

/** A storage or network error means "no bytes", like a missing file, so callers never throw on an unreadable file. */
async function loadArtworkBytes(url: string, deps: ManifestLoadDeps): Promise<Buffer | null> {
  const local = bytesFor(url);
  if (local) return local;
  const maxBytes = deps.maxBytes ?? MANIFEST_MAX_BYTES;
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
): Promise<FileManifest | null> {
  const delivery = await loadArtworkBytes(deliveryUrl, deps);
  const preview = await loadArtworkBytes(previewUrl, deps);
  return assembleManifest(deliveryUrl, previewUrl, delivery, preview);
}

export function manifestIsComplete(manifest: FileManifest | null | undefined) {
  const file = manifest?.delivery;
  if (!file) return false;
  return Boolean(
    file.filename &&
      file.width > 0 &&
      file.height > 0 &&
      file.bytes > 0 &&
      /^[a-f0-9]{64}$/.test(file.sha256),
  );
}
