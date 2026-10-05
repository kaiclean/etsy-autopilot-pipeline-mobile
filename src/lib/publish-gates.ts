import type { FileManifest } from "@/db/schema";
import { manifestIsComplete } from "./file-manifest";

export function isMockPlaceholder(imageProvider: string, designProvider: string | null) {
  return imageProvider === "mock" || designProvider === "mock" || designProvider === "mock-template";
}

/**
 * Cron may create an Etsy draft. It may not activate.
 * Live drafts are refused for the mock placeholder and for a missing manifest.
 */
export function digitalDraftRefusal(input: {
  etsyMode: "dry-run" | "live";
  imageProvider: string;
  designProvider: string | null;
  imageUrl: string;
  deliveryUrl: string | null;
  manifest: FileManifest | null;
}): string | null {
  if (input.etsyMode === "live" && isMockPlaceholder(input.imageProvider, input.designProvider)) {
    return "Refusing to publish digital: the image provider is the mock placeholder. Generate the file with a real image provider first.";
  }
  if (!input.deliveryUrl) return "Refusing to publish digital: the delivery file URL is not recorded.";
  if (input.imageUrl === input.deliveryUrl) {
    return "Refusing to publish digital: the gallery image is the full-resolution deliverable. Use a downscaled preview.";
  }
  if (input.etsyMode === "live" && !manifestIsComplete(input.manifest)) {
    return "Refusing to publish digital: record the delivery file (filename, pixel size, bytes, sha256) before creating the Etsy draft.";
  }
  return null;
}

/** Per-listing human activation. No env flag can satisfy this. */
export function digitalActivationRefusal(input: {
  imageProvider: string;
  designProvider: string | null;
  manifest: FileManifest | null;
  fileVerifiedAt: Date | null;
  etsyListingId: string | null;
  imageUrl: string;
  deliveryUrl: string | null;
}): string | null {
  if (isMockPlaceholder(input.imageProvider, input.designProvider)) {
    return "Cannot activate: the artwork is the mock placeholder.";
  }
  if (!manifestIsComplete(input.manifest)) {
    return "Cannot activate: record the delivery file (filename, pixel size, bytes, sha256) first.";
  }
  if (!input.fileVerifiedAt) return "Cannot activate: a human must open the delivery file and mark it verified.";
  if (!input.etsyListingId) return "Cannot activate: the Etsy draft does not exist yet.";
  if (!input.deliveryUrl || input.imageUrl === input.deliveryUrl) {
    return "Cannot activate: the gallery image is the full-resolution deliverable.";
  }
  return null;
}

export function podEtsyPublishRefusal(input: {
  blueprintId: number | null;
  providerId: number | null;
  sampleApprovedAt: Date | null;
  printifyProductId: string | null;
  alreadyPublished: boolean;
}): string | null {
  if (input.alreadyPublished) return "This product was already sent to Etsy.";
  if (!input.printifyProductId) return "Create the Printify product before publishing it to Etsy.";
  if (!input.blueprintId || !input.providerId) {
    return "Blueprint and print provider are not recorded, so a sample cannot be checked.";
  }
  if (!input.sampleApprovedAt) {
    return `No physical sample is recorded for blueprint ${input.blueprintId} and provider ${input.providerId}.`;
  }
  return null;
}

export const LIVE_PROVIDER_PIN_ERROR =
  "Live Printify will not auto-select a blueprint or print provider. Set PRINTIFY_BLUEPRINT_ID, PRINTIFY_PRINT_PROVIDER_ID and PRINTIFY_VARIANT_IDS. Record a physical sample for that pair before publishing to Etsy.";
