import type { ProductType } from "@/db/schema";

/**
 * Wall-art ratios buyers expect from a finished printable pack.
 * The pipeline does not export these yet: publish uploads one PNG.
 * A later change should resample the artwork to 300 DPI at each ratio and ship a ZIP or PDF.
 */
export const PLANNED_WALL_ART_RATIOS = ["2:3", "3:4", "4:5", "11x14", "ISO A"] as const;

/** Buyer-facing file list. Must match the single PNG `runPublish` uploads for digital listings. */
export const DIGITAL_FILE_BLURB = [
  "WHAT YOU GET",
  "• One PNG of this artwork",
  "• Instant download after purchase",
].join("\n");

const UNSUPPORTED_LINE =
  /300\s*dpi|2:3|3:4|4:5|11\s*x\s*14|iso\s*a|corjl|canva|fully editable|edit the text|editable template|zip|pdf bundle/i;

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
