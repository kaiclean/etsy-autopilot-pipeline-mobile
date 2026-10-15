import { createHash } from "node:crypto";
import type { Listing } from "@/db/schema";

/** Canonical attachment revision, independent of JSONB key ordering and human verification timestamps. */
export function etsyDeliveryFingerprint(listing: Pick<Listing, "deliveryUrl" | "fileManifest" | "deliveryPack">): string | null {
  const primary = listing.fileManifest?.delivery;
  if (!listing.deliveryUrl || !primary) return null;
  const files = [{ ...primary, url: listing.deliveryUrl }, ...(listing.deliveryPack?.files ?? [])];
  const records = files.map((file) => ({
    url: file.url, filename: file.filename, sha256: file.sha256,
    width: file.width, height: file.height, bytes: file.bytes,
  }));
  return createHash("sha256").update(`etsy-delivery:v1:${JSON.stringify(records)}`).digest("hex");
}
