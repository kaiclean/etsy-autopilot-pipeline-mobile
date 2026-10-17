import { and, eq, isNull, sql } from "drizzle-orm";
import type { DB } from "@/db";
import { listings } from "@/db/schema";
import { inspectArtworkFile, manifestIsComplete } from "@/lib/file-manifest";
import { loadArtworkBytes } from "@/lib/artwork-source";
import {
  MAX_PACK_FILE_BYTES, storeArtworkPack, verifyListingDeliveryPack, withArtworkPackContents,
  type ArtworkExportSpec,
} from "@/lib/artwork-pack";
import { uploadImageBytes } from "@/lib/object-storage";

export class ArtworkExportError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}

export type ListingExportDeps = {
  read?: (url: string) => Promise<Buffer | null>;
  upload?: (bytes: Buffer, contentType: string) => Promise<{ url: string } | null>;
};

export function parseArtworkExportSpecs(input: unknown): ArtworkExportSpec[] {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some((key) => key !== "exports")) throw new ArtworkExportError("Use an exports array; source artwork comes from the listing.");
  const exports = (input as { exports?: unknown }).exports;
  if (!Array.isArray(exports) || exports.length < 1 || exports.length > 4) {
    throw new ArtworkExportError("Request 1 to 4 exports; the original remains the fifth-file maximum.");
  }
  const names = new Set<string>();
  return exports.map((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ArtworkExportError("Each export must be an object.");
    const file = value as Record<string, unknown>;
    if (Object.keys(file).some((key) => !["filename", "width", "height", "format"].includes(key)) ||
        typeof file.filename !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(file.filename) ||
        !["png", "jpeg", "webp"].includes(String(file.format)) ||
        !file.filename.toLowerCase().endsWith(file.format === "jpeg" ? ".jpg" : `.${file.format}`) ||
        !Number.isSafeInteger(file.width) || !Number.isSafeInteger(file.height) ||
        Number(file.width) < 1 || Number(file.height) < 1 || names.has(file.filename.toLowerCase())) {
      throw new ArtworkExportError("Invalid export dimensions, filename, format or duplicate filename.");
    }
    names.add(file.filename.toLowerCase());
    return file as ArtworkExportSpec;
  });
}

/** Stores only operator-requested files. It never creates or edits an Etsy listing. */
export async function createListingExports(db: DB, shopId: string, listingId: number, input: unknown, deps: ListingExportDeps = {}) {
  const specs = parseArtworkExportSpecs(input);
  const [listing] = await db.select().from(listings).where(and(eq(listings.id, listingId), eq(listings.shopId, shopId)));
  if (!listing) throw new ArtworkExportError("Listing not found.", 404);
  if (listing.productType !== "digital" || listing.etsyListingId !== null ||
      !["pending_approval", "approved", "quality_failed"].includes(listing.status)) {
    throw new ArtworkExportError("Exports require an unsent digital draft.", 409);
  }
  if (!listing.deliveryUrl || !manifestIsComplete(listing.fileManifest)) {
    throw new ArtworkExportError("Record the original delivery manifest before generating exports.", 409);
  }
  const read = deps.read ?? loadArtworkBytes;
  const original = await read(listing.deliveryUrl);
  if (!original || original.length > MAX_PACK_FILE_BYTES) throw new ArtworkExportError("The original must be readable and at most 20MB.");
  const primary = await inspectArtworkFile(original, listing.fileManifest!.delivery.filename);
  if (!primary || primary.sha256 !== listing.fileManifest!.delivery.sha256 ||
      primary.bytes !== listing.fileManifest!.delivery.bytes ||
      primary.width !== listing.fileManifest!.delivery.width || primary.height !== listing.fileManifest!.delivery.height) {
    throw new ArtworkExportError("Original delivery bytes changed; record its manifest and verify it again.", 409);
  }
  if (specs.some((file) => file.filename.toLowerCase() === primary.filename.toLowerCase())) {
    throw new ArtworkExportError("An export filename duplicates the original delivery filename.");
  }
  let pack;
  try {
    pack = await storeArtworkPack(original, specs, {
      upload: deps.upload ?? ((bytes, contentType) => uploadImageBytes(bytes, contentType, true)),
      read,
    }, (listing.fileManifest as { provenance?: import("@/lib/artwork-provenance").ArtworkProvenance }).provenance);
  } catch {
    throw new ArtworkExportError("Exports could not be generated and verified. Use same-aspect sizes no larger than the original, and check object storage.", 422);
  }
  pack.source = primary;
  if (!await verifyListingDeliveryPack({ ...listing, deliveryPack: pack }, read)) {
    throw new ArtworkExportError("Delivery objects changed while exports were prepared; no pack was attached.", 409);
  }
  const [updated] = await db.update(listings).set({
    deliveryPack: pack,
    description: withArtworkPackContents(listing.description, pack, false),
    status: "pending_approval",
    approvedAt: null,
    fileVerifiedAt: null,
    fileVerifiedBy: null,
    updatedAt: new Date(),
  }).where(and(
    eq(listings.id, listingId), eq(listings.shopId, shopId), isNull(listings.etsyListingId),
    eq(listings.status, listing.status), eq(listings.deliveryUrl, listing.deliveryUrl),
    eq(listings.description, listing.description),
    sql`${listings.fileManifest} IS NOT DISTINCT FROM ${JSON.stringify(listing.fileManifest)}::jsonb`,
    sql`${listings.deliveryPack} IS NOT DISTINCT FROM ${listing.deliveryPack ? JSON.stringify(listing.deliveryPack) : null}::jsonb`,
  )).returning({ id: listings.id });
  if (!updated) throw new ArtworkExportError("Listing changed while exports were generated. Nothing was attached; retry after reviewing the draft.", 409);
  return { ok: true as const, deliveryPack: pack, verificationRequired: true };
}
