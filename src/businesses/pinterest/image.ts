import { isOwnStorageUrl } from "@/lib/object-storage";

/** Stored object URL only. Listing pages on etsy.com are never fetched. */
export function s3PinImage(url: string | null | undefined): string | null {
  if (!url) return null;
  if (isOwnStorageUrl(url)) return url;
  if (/^https:\/\//i.test(url) && /(s3[.-]|amazonaws\.com|r2\.cloudflarestorage\.com)/i.test(url)) return url;
  return null;
}
