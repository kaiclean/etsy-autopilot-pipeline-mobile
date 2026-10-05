import { createHash } from "node:crypto";
import type { FileManifest } from "@/db/schema";
import { decodeDataUrl } from "./object-storage";
import { localAssetPng } from "./png";

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

/** Reads local or data-URL bytes. Remote http files are left unrecorded so publish cannot invent a hash. */
export function tryBuildFileManifest(deliveryUrl: string, previewUrl: string): FileManifest | null {
  const delivery = bytesFor(deliveryUrl);
  if (!delivery) return null;
  const deliveryFile = inspectPng(delivery, filenameFor(deliveryUrl, "artwork.png"));
  if (!deliveryFile) return null;
  const previewBytes = bytesFor(previewUrl);
  const preview = previewBytes ? inspectPng(previewBytes, filenameFor(previewUrl, "preview.png")) : null;
  if (preview && preview.sha256 === deliveryFile.sha256) return null;
  return { delivery: deliveryFile, ...(preview ? { preview } : {}) };
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
