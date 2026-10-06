import { sql, type SQL } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";
import { materializeImageUrl, type MaterializeDeps } from "@/lib/object-storage";
import { digitalPreviewUrl } from "@/lib/png";

/**
 * Neon’s HTTP driver refuses a result larger than 64 MiB. A few hundred
 * `data:` images, or the same image repeated once per order, cross that line.
 * List queries may return a URL only when it is already this small and does
 * not carry an inline payload.
 */
export const MAX_LIST_IMAGE_URL_BYTES = 8192;

const DATA_MARKER = /data:|data%3a/i;

export function containsInlineImage(url: string) {
  return DATA_MARKER.test(url);
}

/** Pull a `data:` payload out of a raw image URL or a preview `src` query param. */
export function extractInlineDataUrl(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed.startsWith("data:")) return trimmed;
  const query = trimmed.indexOf("?");
  if (query < 0) return null;
  const src = new URLSearchParams(trimmed.slice(query + 1)).get("src");
  return src?.startsWith("data:") ? src : null;
}

/** Point an `/api/...` URL at a stored object and drop any inline `src`. */
export function replacePreviewSrc(url: string, storedUrl: string) {
  const query = url.indexOf("?");
  const path = query >= 0 ? url.slice(0, query) : url;
  const params = query >= 0 ? new URLSearchParams(url.slice(query + 1)) : new URLSearchParams();
  params.delete("src");
  if (storedUrl && !containsInlineImage(storedUrl) && storedUrl.length <= MAX_LIST_IMAGE_URL_BYTES) {
    params.set("src", storedUrl);
  }
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

/**
 * Rewrite stored fields after the inline bytes have been uploaded.
 * When the gallery and the delivery file are the same data URL, the gallery
 * becomes a preview of the stored object so the two URLs stay different.
 */
export function applyStoredImageUrls(input: {
  imageUrl: string;
  deliveryUrl: string | null;
  niche: string | null;
  storedByDataUrl: ReadonlyMap<string, string>;
}): { imageUrl: string; deliveryUrl: string | null } {
  const imageData = extractInlineDataUrl(input.imageUrl);
  const deliveryData = input.deliveryUrl ? extractInlineDataUrl(input.deliveryUrl) : null;
  let imageUrl = input.imageUrl;
  let deliveryUrl = input.deliveryUrl;

  if (deliveryData) {
    const stored = input.storedByDataUrl.get(deliveryData);
    if (!stored) throw new Error("Missing stored URL for a delivery image");
    deliveryUrl = stored;
  }
  if (imageData) {
    const stored = input.storedByDataUrl.get(imageData);
    if (!stored) throw new Error("Missing stored URL for a gallery image");
    if (input.imageUrl.trim().startsWith("data:")) {
      imageUrl = deliveryData === imageData ? digitalPreviewUrl(stored, input.niche ?? "alpine") : stored;
    } else {
      imageUrl = replacePreviewSrc(input.imageUrl, stored);
    }
  }
  return { imageUrl, deliveryUrl };
}

/** Upload a data URL when storage is configured. Never return an inline payload. */
export async function persistableImageUrl(url: string, deps: MaterializeDeps = {}): Promise<string> {
  const stored = await materializeImageUrl(url, deps);
  if (containsInlineImage(stored)) {
    throw new Error(
      "Refusing to store an inline image. Set the existing S3 variables (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_ENDPOINT_URL_S3, AWS_REGION, S3_BUCKET) or BLOB_READ_WRITE_TOKEN.",
    );
  }
  return stored;
}

function strippedApiUrl(column: AnyColumn): SQL {
  const withoutSrc = sql`regexp_replace(${column}, '[?&]src=[^&]*', '', 'g')`;
  return sql`CASE
    WHEN position('?' in (${withoutSrc})) = 0 AND position('&' in (${withoutSrc})) > 0
      THEN overlay((${withoutSrc}) placing '?' from position('&' in (${withoutSrc})) for 1)
    ELSE (${withoutSrc})
  END`;
}

/**
 * SQL expression whose result never includes a `data:` payload.
 * Short http(s) and app paths pass through. Oversized `/api/` URLs drop `src`.
 * Anything else oversized becomes NULL.
 */
export function compactImageUrlSql(column: AnyColumn): SQL<string | null> {
  const stripped = strippedApiUrl(column);
  return sql<string | null>`CASE
    WHEN ${column} IS NULL OR ${column} = '' THEN NULL
    WHEN octet_length(${column}) <= ${MAX_LIST_IMAGE_URL_BYTES}
      AND position('data:' in ${column}) = 0
      AND position('data%3A' in ${column}) = 0
      AND position('data%3a' in ${column}) = 0
      THEN ${column}
    WHEN position('/api/' in left(${column}, 160)) > 0
      AND octet_length((${stripped})) <= ${MAX_LIST_IMAGE_URL_BYTES}
      AND position('data:' in (${stripped})) = 0
      AND position('data%3A' in (${stripped})) = 0
      AND position('data%3a' in (${stripped})) = 0
      THEN NULLIF((${stripped}), '')
    ELSE NULL
  END`;
}

/** Compact URL, or a niche preview when the stored value is an inline payload. */
export function displayImageUrlSql(image: AnyColumn, niche: AnyColumn): SQL<string | null> {
  const compact = compactImageUrlSql(image);
  return sql<string | null>`CASE
    WHEN ${niche} IS NULL OR ${niche} = '' THEN ${compact}
    ELSE coalesce(${compact}, '/api/preview?niche=' || ${niche})
  END`;
}

/** True when a column can hold an inline image that must not be selected in full. */
export function inlineImagePredicate(column: AnyColumn): SQL {
  return sql`(
    left(${column}, 5) = 'data:'
    OR position('data:' in ${column}) > 0
    OR position('data%3A' in ${column}) > 0
    OR position('data%3a' in ${column}) > 0
    OR octet_length(${column}) > ${MAX_LIST_IMAGE_URL_BYTES}
  )`;
}
