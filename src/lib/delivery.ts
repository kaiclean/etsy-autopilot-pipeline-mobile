import type { ProductType } from "@/db/schema";

/**
 * Wall-art ratios buyers expect from a finished printable pack.
 * The Produce stage renders these at 300 DPI for wall-art downloads (see `PRINT_SPECS` in deliverables.ts).
 * Listings without produced files keep the one-PNG blurb below.
 */
export const PLANNED_WALL_ART_RATIOS = ["2:3", "3:4", "4:5", "11x14", "ISO A"] as const;

/** Buyer-facing file list. Must match the single PNG `runPublish` uploads for digital listings. */
export const DIGITAL_FILE_BLURB = [
  "WHAT YOU GET",
  "• One PNG of this artwork",
  "• Instant download after purchase",
].join("\n");

/** Print sizes and DPI. A complete print pack makes these true. */
export const PRINT_SIZE_PROMISE = /300\s*dpi|2:3|3:4|4:5|11\s*x\s*14|iso\s*a/i;
/** Archive deliveries. The shop never ships these. */
export const BUNDLE_PROMISE = /\bzip\b|pdf bundle/i;
/** Editable templates. The shop never ships these. */
export const EDITABLE_PROMISE = /corjl|canva|fully editable|edit the text|editable template/i;

const UNSUPPORTED_LINE = new RegExp(`${PRINT_SIZE_PROMISE.source}|zip|pdf bundle|${EDITABLE_PROMISE.source}`, "i");

/**
 * Drop lines that promise print ratios, 300 DPI packs, or editable templates,
 * then state the one PNG the shop actually delivers.
 */
export function alignDeliveryCopy(body: string, productType: ProductType) {
  if (productType !== "digital") return body.trim();
  const withoutPack = body.replace(/\n*WHAT YOU GET[\s\S]*$/i, "");
  const kept = withoutPack
    .split("\n")
    .filter((line) => !UNSUPPORTED_LINE.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return `${kept}\n\n${DIGITAL_FILE_BLURB}`.trim();
}
