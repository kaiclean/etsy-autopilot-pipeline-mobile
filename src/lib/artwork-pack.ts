import sharp from "sharp";
import { inspectArtwork, MAX_ARTWORK_PIXELS, type ArtworkFormat } from "@/lib/artwork-codec";
import type { ArtworkProvenance } from "@/lib/artwork-provenance";
import { inspectArtworkFile, manifestIsComplete, type ArtworkFileRecord } from "@/lib/file-manifest";
import { isSafeArtworkUrl } from "@/lib/art-quality";
import { loadArtworkBytes } from "@/lib/artwork-source";
import type { FileManifest } from "@/db/schema";

export const MAX_PACK_FILE_BYTES = 20 * 1024 * 1024;
export type ArtworkExportSpec = { filename: string; width: number; height: number; format: ArtworkFormat };
export type GeneratedArtworkExport = { bytes: Buffer; contentType: string; file: ArtworkFileRecord };
export type ArtworkPackManifest = {
  version: 1;
  source: ArtworkFileRecord;
  files: Array<ArtworkFileRecord & { url: string }>;
  provenance?: ArtworkProvenance;
};

/** Explicit opt-in exports only. Different aspect ratios require new compositions, not hidden crops. */
export async function generateArtworkPack(source: Buffer, specs: ArtworkExportSpec[]): Promise<GeneratedArtworkExport[]> {
  const info = await inspectArtwork(source);
  if (!info) throw new Error("Invalid or unsupported artwork source");
  if (!specs.length || specs.length > 4) throw new Error("A pack requires 1 to 4 exports, plus the original");
  const names = new Set<string>();
  for (const spec of specs) {
    if (!["png", "jpeg", "webp"].includes(spec.format) ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(spec.filename) ||
        !spec.filename.toLowerCase().endsWith(spec.format === "jpeg" ? ".jpg" : `.${spec.format}`) ||
        names.has(spec.filename.toLowerCase())) throw new Error("Invalid or duplicate export filename/format");
    names.add(spec.filename.toLowerCase());
    if (!Number.isSafeInteger(spec.width) || !Number.isSafeInteger(spec.height) || spec.width < 1 || spec.height < 1 ||
        spec.width > info.width || spec.height > info.height) throw new Error("Exports cannot upscale the source");
    if (spec.width * info.height !== spec.height * info.width) throw new Error("Exports cannot crop or distort the source aspect ratio");
  }
  const exports: GeneratedArtworkExport[] = [];
  for (const spec of specs) {
    const bytes = await sharp(source, { failOn: "warning", limitInputPixels: MAX_ARTWORK_PIXELS })
      .timeout({ seconds: 15 }).autoOrient().toColourspace("srgb")
      .flatten({ background: "#ffffff" }).removeAlpha()
      .resize(spec.width, spec.height, { fit: "inside", withoutEnlargement: true })
      .toFormat(spec.format).toBuffer();
    if (bytes.length > MAX_PACK_FILE_BYTES) throw new Error("Export exceeds the 20MB delivery-file limit");
    const file = await inspectArtworkFile(bytes, spec.filename);
    if (!file || file.width !== spec.width || file.height !== spec.height) throw new Error("Export validation failed");
    exports.push({ bytes, contentType: `image/${spec.format}`, file: { ...file, colourSpace: "srgb" } });
  }
  return exports;
}

/**
 * No pack is deliverable until every stored object has been read back and hash-verified.
 * This does not publish, activate, attach files to Etsy, or replace human delivery verification.
 */
export async function storeArtworkPack(
  source: Buffer,
  specs: ArtworkExportSpec[],
  storage: {
    upload: (bytes: Buffer, contentType: string) => Promise<{ url: string } | null>;
    read: (url: string) => Promise<Buffer | null>;
  },
  provenance?: ArtworkProvenance,
): Promise<ArtworkPackManifest> {
  const sourceFile = await inspectArtworkFile(source, "source");
  if (!sourceFile) throw new Error("Invalid artwork source");
  if (sourceFile.bytes > MAX_PACK_FILE_BYTES) throw new Error("Original exceeds the 20MB delivery-file limit");
  const exports = await generateArtworkPack(source, specs);
  const files: ArtworkPackManifest["files"] = [];
  const urls = new Set<string>();
  for (const generated of exports) {
    const stored = await storage.upload(generated.bytes, generated.contentType);
    if (!stored?.url || !isSafeArtworkUrl(stored.url) ||
        /[?&](x-amz-|x-goog-|signature=|expires=|token=)/i.test(stored.url) ||
        urls.has(stored.url)) throw new Error("Export upload did not return a distinct permanent public HTTPS URL");
    urls.add(stored.url);
    const readBack = await storage.read(stored.url);
    if (!readBack || readBack.length > MAX_PACK_FILE_BYTES) throw new Error("Stored export could not be verified");
    const verified = await inspectArtworkFile(readBack, generated.file.filename);
    if (!verified || verified.sha256 !== generated.file.sha256) throw new Error("Stored export hash mismatch");
    files.push({ ...generated.file, url: stored.url });
  }
  return { version: 1, source: sourceFile, files, ...(provenance ? { provenance } : {}) };
}

export function deliveryPackIsComplete(pack: ArtworkPackManifest | null | undefined, primary?: FileManifest["delivery"] | null): boolean {
  if (!pack || pack.version !== 1 || !manifestIsComplete({ delivery: pack.source }) ||
      pack.source.bytes > MAX_PACK_FILE_BYTES || !Array.isArray(pack.files) || pack.files.length < 1 || pack.files.length > 4) return false;
  if (primary && (pack.source.sha256 !== primary.sha256 || pack.source.width !== primary.width ||
      pack.source.height !== primary.height || pack.source.bytes !== primary.bytes)) return false;
  const names = new Set<string>([pack.source.filename.toLowerCase()]);
  const urls = new Set<string>();
  for (const file of pack.files) {
    if (!file || !manifestIsComplete({ delivery: file }) || file.bytes > MAX_PACK_FILE_BYTES ||
        !["png", "jpeg", "webp"].includes(file.format) || typeof file.url !== "string" || !isSafeArtworkUrl(file.url) ||
        /[?&](x-amz-|x-goog-|signature=|expires=|token=)/i.test(file.url) ||
        names.has(file.filename.toLowerCase()) || urls.has(file.url) ||
        file.width > pack.source.width || file.height > pack.source.height ||
        file.width * pack.source.height !== file.height * pack.source.width) return false;
    names.add(file.filename.toLowerCase());
    urls.add(file.url);
  }
  return true;
}

/** Read every attached object again; a historic hash or a human timestamp is not a storage check. */
export async function verifyDeliveryPack(
  pack: ArtworkPackManifest | null | undefined,
  primary: FileManifest["delivery"] | null | undefined,
  read: (url: string) => Promise<Buffer | null> = loadArtworkBytes,
): Promise<boolean> {
  if (!pack) return true;
  if (!primary || !deliveryPackIsComplete(pack, primary)) return false;
  try {
    for (const file of pack.files) {
      const bytes = await read(file.url);
      if (!bytes || bytes.length > MAX_PACK_FILE_BYTES) return false;
      const actual = await inspectArtworkFile(bytes, file.filename);
      if (!actual || actual.sha256 !== file.sha256 || actual.width !== file.width ||
          actual.height !== file.height || actual.bytes !== file.bytes || actual.format !== file.format) return false;
    }
    return true;
  } catch {
    return false;
  }
}

const CONTENTS_START = "--- Digital file contents ---";
const CONTENTS_END = "--- End digital file contents ---";

export function withArtworkPackContents(description: string, pack: ArtworkPackManifest, verified: boolean): string {
  const start = description.indexOf(CONTENTS_START);
  const end = start < 0 ? -1 : description.indexOf(CONTENTS_END, start);
  const base = start >= 0 && end >= 0 ? `${description.slice(0, start)}${description.slice(end + CONTENTS_END.length)}`.trim() : description.trim();
  const files = [pack.source, ...pack.files];
  const heading = verified ? `Included digital files (${files.length}):` :
    `Prepared digital files (${files.length}); awaiting human verification, not yet approved for delivery:`;
  return `${base}\n\n${CONTENTS_START}\n${heading}\n${files.map((file) =>
    `- ${file.filename}: ${file.width} × ${file.height} pixels`).join("\n")}\n${CONTENTS_END}`;
}
