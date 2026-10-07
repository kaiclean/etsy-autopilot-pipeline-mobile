import type { Deliverable, Niche, ProductType, ValidationIssue } from "@/db/schema";
import { BUNDLE_PROMISE, DIGITAL_FILE_BLURB, EDITABLE_PROMISE, PRINT_SIZE_PROMISE } from "./delivery";
import { validateListing, type ListingDraft } from "./listing-validator";

export const PRINT_DPI = 300;

/**
 * Etsy digital listings take up to 5 files of at most 20 MB each, per Etsy seller guides
 * (Etsy Help article 115015628347; not read directly). The pack below uses all 5 slots.
 */
export const ETSY_FILE_LIMITS = { maxFiles: 5, maxBytes: 20 * 1024 * 1024 } as const;

/** Stay under the object-storage cap in object-storage.ts as well as Etsy's limit. */
export const PACK_MAX_BYTES = 15 * 1024 * 1024;

export type PrintSpec = { ratio: Deliverable["ratio"]; width: number; height: number; prints: string };

/** Largest size per ratio at 300 DPI. Buyers scale down for the smaller prints listed. */
export const PRINT_SPECS: readonly PrintSpec[] = [
  { ratio: "2:3", width: 4000, height: 6000, prints: "4×6, 8×12, 12×18 in" },
  { ratio: "3:4", width: 4500, height: 6000, prints: "6×8, 9×12, 12×16 in" },
  { ratio: "4:5", width: 4800, height: 6000, prints: "8×10, 16×20 in" },
  { ratio: "11x14", width: 3300, height: 4200, prints: "11×14 in" },
  { ratio: "ISO A", width: 3508, height: 4961, prints: "A5, A4, A3" },
];

/** Niches whose downloads are wall art. Invitations and stream graphics keep the one-PNG delivery. */
export const PRINT_PACK_NICHES: readonly Niche[] = ["alpine", "gothic", "christmas"];

/** Above this enlargement the approval queue warns to check sharpness. */
export const MAX_CLEAN_UPSCALE = 4;

export function inchesAt(px: number, dpi = PRINT_DPI) {
  return px / dpi;
}

export function needsPrintPack(l: { productType: ProductType; niche: Niche }) {
  return l.productType === "digital" && PRINT_PACK_NICHES.includes(l.niche);
}

/** Every spec has a file of at least its pixel size. */
export function packIsComplete(files: Deliverable[]) {
  return PRINT_SPECS.every((s) => files.some((f) => f.ratio === s.ratio && f.width >= s.width && f.height >= s.height));
}

export function printPackBlurb(files: Deliverable[]) {
  const lines = PRINT_SPECS.map((s) => {
    const f = files.find((x) => x.ratio === s.ratio);
    const w = f?.width ?? s.width;
    const h = f?.height ?? s.height;
    return `• ${s.ratio} ratio, ${w} × ${h} px: prints ${s.prints}`;
  });
  return [
    "WHAT YOU GET",
    `• ${PRINT_SPECS.length} high-resolution JPG files (${PRINT_DPI} DPI)`,
    ...lines,
    "• Instant download after purchase",
    "• Frame and print not included",
  ].join("\n");
}

/** Replaces the one-PNG blurb with the pack blurb. Returns null when the blurb was edited away. */
export function withPrintPackCopy(description: string, files: Deliverable[]) {
  if (!description.includes(DIGITAL_FILE_BLURB)) return null;
  return description.replace(DIGITAL_FILE_BLURB, printPackBlurb(files));
}

/** Checks that what the description promises matches the files a buyer will receive. */
export function checkDelivery(l: { productType: ProductType; description: string }, files: Deliverable[]): ValidationIssue[] {
  if (l.productType !== "digital") return [];
  const issues: ValidationIssue[] = [];
  const description = l.description ?? "";
  if (files.length > ETSY_FILE_LIMITS.maxFiles) {
    issues.push({
      field: "files",
      severity: "error",
      code: "too_many_files",
      message: `Etsy allows ${ETSY_FILE_LIMITS.maxFiles} files per listing (found ${files.length}).`,
    });
  }
  const big = files.filter((f) => f.bytes > ETSY_FILE_LIMITS.maxBytes);
  if (big.length) {
    issues.push({
      field: "files",
      severity: "error",
      code: "file_too_large",
      message: `${big.map((f) => f.name).join(", ")} exceed Etsy's 20 MB file limit.`,
    });
  }
  if (PRINT_SIZE_PROMISE.test(description) && !packIsComplete(files)) {
    issues.push({
      field: "description",
      severity: "error",
      code: "delivery_mismatch",
      message: "The description promises print sizes or 300 DPI files that the delivered files do not cover. Run Produce or remove those lines.",
    });
  }
  if (BUNDLE_PROMISE.test(description)) {
    issues.push({ field: "description", severity: "error", code: "delivery_bundle", message: "The description promises a ZIP or PDF bundle, which the shop does not deliver." });
  }
  if (EDITABLE_PROMISE.test(description)) {
    issues.push({ field: "description", severity: "error", code: "delivery_editable", message: "The description promises an editable template, which the shop does not deliver." });
  }
  if (files.some((f) => f.upscale > MAX_CLEAN_UPSCALE)) {
    const worst = Math.max(...files.map((f) => f.upscale));
    issues.push({
      field: "files",
      severity: "warning",
      code: "upscale_high",
      message: `Print files were enlarged up to ${worst.toFixed(1)}× from the artwork. Open one and check sharpness before approving.`,
    });
  }
  if (files.length && files.some((f) => !f.stored)) {
    issues.push({
      field: "files",
      severity: "warning",
      code: "files_not_stored",
      message: "Print files were rendered but not stored. Set S3 or Vercel Blob before going live.",
    });
  }
  return issues;
}

/** The gate for approval and publishing: listing rules plus the delivery check. */
export function validateForPublish(l: ListingDraft & { deliverables?: Deliverable[] | null }) {
  const base = validateListing(l);
  const issues = [...base.issues, ...checkDelivery(l, l.deliverables ?? [])];
  return { valid: !issues.some((i) => i.severity === "error"), issues };
}
