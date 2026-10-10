import { config, publicAppUrl, storageBackend } from "@/lib/config";

export type StoredObject = { url: string; key: string; backend: "s3" | "blob" };

export type MaterializeDeps = {
  upload?: (bytes: Buffer, contentType: string) => Promise<StoredObject | null>;
  fetchImpl?: typeof fetch;
};

const DATA_URL = /^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,([\s\S]*)$/;
export const MAX_ARTWORK_BYTES = 50 * 1024 * 1024;

/** Keys the media proxy is willing to stream. Untrusted path segments are rejected. */
export const MEDIA_KEY = /^designs\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\.(png|jpe?g|webp|gif)$/i;

export function decodeDataUrl(url: string): { bytes: Buffer; contentType: string } | null {
  const match = DATA_URL.exec(url);
  if (!match) return null;
  const contentType = match[1] || "application/octet-stream";
  const payload = match[3] ?? "";
  const bytes = match[2] ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8");
  if (bytes.length === 0) return null;
  return { bytes, contentType };
}

export function extensionFor(contentType: string) {
  const type = contentType.toLowerCase();
  if (type.includes("jpeg") || type.includes("jpg")) return "jpg";
  if (type.includes("webp")) return "webp";
  if (type.includes("gif")) return "gif";
  return "png";
}

export function newObjectKey(contentType: string, now = new Date()) {
  return `designs/${now.toISOString().slice(0, 10)}/${crypto.randomUUID()}.${extensionFor(contentType)}`;
}

export function isOwnStorageUrl(url: string) {
  if (url.includes("/api/media/designs/")) return true;
  const base = config.storage.publicBaseUrl;
  return Boolean(base && (url === base || url.startsWith(`${base}/`)));
}

async function s3Client() {
  const { S3Client } = await import("@aws-sdk/client-s3");
  const s = config.storage;
  return new S3Client({
    region: s.region,
    endpoint: s.endpoint,
    forcePathStyle: s.forcePathStyle,
    credentials: {
      accessKeyId: s.accessKeyId ?? "",
      secretAccessKey: s.secretAccessKey ?? "",
    },
  });
}

async function urlForStoredKey(key: string): Promise<string> {
  const s = config.storage;
  if (s.publicBaseUrl) return `${s.publicBaseUrl}/${key}`;
  if (storageBackend() === "s3" && s.urlMode === "signed") {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
    return getSignedUrl(await s3Client(), new GetObjectCommand({ Bucket: s.bucket, Key: key }), { expiresIn: 60 * 60 * 24 * 7 });
  }
  return `${publicAppUrl()}/api/media/${key}`;
}

/** Upload image bytes. S3 wins when its credentials and bucket are set; otherwise Vercel Blob. */
export async function uploadImageBytes(bytes: Buffer, contentType: string): Promise<StoredObject | null> {
  const backend = storageBackend();
  if (backend === "none") return null;
  if (bytes.length > MAX_ARTWORK_BYTES) throw new Error("Generated image is larger than 50MB");
  const key = newObjectKey(contentType);
  if (backend === "s3") {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    await (await s3Client()).send(
      new PutObjectCommand({
        Bucket: config.storage.bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
        CacheControl: "public, max-age=31536000, immutable",
      }),
    );
    return { url: await urlForStoredKey(key), key, backend: "s3" };
  }
  const { put } = await import("@vercel/blob");
  const blob = await put(key, bytes, {
    access: "public",
    token: config.storage.blobToken,
    contentType,
    addRandomSuffix: false,
    cacheControlMaxAge: 60 * 60 * 24 * 365,
  });
  return { url: blob.url, key, backend: "blob" };
}

/**
 * Replace a data URL or temporary provider URL with a stored URL.
 * Relative mock art (`/api/placeholder/...`) is left alone.
 * With no storage configured, the original URL is returned.
 */
export async function materializeImageUrl(url: string, deps: MaterializeDeps = {}): Promise<string> {
  if (isOwnStorageUrl(url)) return url;
  const remote = /^https?:\/\//i.test(url);
  const data = url.startsWith("data:");
  if (!remote && !data) return url;
  if (storageBackend() === "none") return url;

  let bytes: Buffer;
  let contentType: string;
  if (data) {
    const decoded = decodeDataUrl(url);
    if (!decoded) return url;
    bytes = decoded.bytes;
    contentType = decoded.contentType;
  } else {
    const res = await (deps.fetchImpl ?? fetch)(url);
    if (!res.ok) return url;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return url;
    bytes = buf;
    contentType = res.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
  }
  const stored = await (deps.upload ?? uploadImageBytes)(bytes, contentType);
  return stored?.url ?? url;
}

export async function withStoredUrl<T extends { url: string }>(image: T): Promise<T> {
  const url = await materializeImageUrl(image.url);
  return url === image.url ? image : { ...image, url };
}

export async function readStoredObject(key: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  if (!MEDIA_KEY.test(key) || storageBackend() !== "s3") return null;
  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  try {
    const out = await (await s3Client()).send(new GetObjectCommand({ Bucket: config.storage.bucket, Key: key }));
    const bytes = await out.Body?.transformToByteArray();
    if (!bytes) return null;
    return { bytes, contentType: out.ContentType || contentTypeForKey(key) };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "NoSuchKey" || name === "NotFound") return null;
    throw error;
  }
}

function contentTypeForKey(key: string) {
  const ext = key.split(".").pop()?.toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return "image/png";
}
