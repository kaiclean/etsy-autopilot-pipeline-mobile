import { withOperationLease } from "@/lib/operation-lease";
import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { getPrintifyAdapter } from "@/adapters/printify";
import type { DB } from "@/db";
import { designs, listings, type Listing, type ValidationIssue } from "@/db/schema";
import { publicAppUrl } from "@/lib/config";
import { appendProviderDetails, validProviderDetails } from "@/lib/disclosures";
import { validateListing } from "@/lib/listing-validator";
import { MIN_SUPPLIER_MOCKUPS, podPresetFromProvider, supplierMockupCount, WAITING_FOR_PRINTIFY_MOCKUPS } from "@/lib/quality-gate";
import type { ArtworkGalleryView } from "./mockup";

export { WAITING_FOR_PRINTIFY_MOCKUPS };

function absoluteUrl(url: string) {
  return new URL(url, `${publicAppUrl()}/`).toString();
}

function snapshotWhere(listing: Listing) {
  return and(
    eq(listings.id, listing.id),
    eq(listings.status, listing.status),
    eq(listings.updatedAt, listing.updatedAt),
    eq(listings.publishAttemptCount, listing.publishAttemptCount),
    listing.publishAttemptedAt ? eq(listings.publishAttemptedAt, listing.publishAttemptedAt) : isNull(listings.publishAttemptedAt),
  );
}

function fixedSupplierError(error: unknown): ValidationIssue | undefined {
  const message = error instanceof Error ? error.message : "";
  const pin = /^(No Printify blank pinned for [^.\r\n]+)\./.exec(message)?.[1];
  const nativeSize = /^Printify \w+ artwork is \d+×\d+; minimum \d+×\d+ native pixels required \(no upscaling\)$/.test(message);
  const decoded = message === "Printify artwork could not be decoded; a real print file is required";
  if (!pin && !nativeSize && !decoded) return undefined;
  return { field: "image", severity: "error", code: "supplier_preview_error", message: pin ?? message };
}

export function validateSupplierApproval(listing: Listing) {
  const check = validateListing(listing);
  const fixed = listing.validation.filter((issue) => issue.code === "supplier_preview_error");
  return { valid: check.valid && fixed.length === 0, issues: [...check.issues, ...fixed] };
}

/** Replace timing claims with current provider facts before copy validation. */
export async function refreshSupplierDescription(db: DB, listing: Listing): Promise<Listing> {
  if (listing.productType !== "pod") return listing;
  const unavailable = {
    ...listing,
    copyProvenance: listing.copyProvenance ? { ...listing.copyProvenance, providerDetails: null } : null,
  };
  const preset = podPresetFromProvider(listing.podProvider);
  if (!preset || (listing.supplier && listing.supplier !== "printify")) return unavailable;
  try {
    const adapter = await getPrintifyAdapter({ db, shopId:listing.shopId, intent: "read" });
    if (!listing.isDemo && adapter.mode !== "live") return unavailable;
    if (adapter.mode === "dry-run" && listing.printifyProductId && !listing.printifyProductId.startsWith("dry-")) return unavailable;
    const providerDetails = await adapter.getProviderDetails?.(preset);
    if (!validProviderDetails(providerDetails)) return unavailable;
    const description = appendProviderDetails(listing.description, providerDetails);
    const copyProvenance = {
      ...(listing.copyProvenance ?? {
        version: 1 as const, provider: "supplier-preview",
        inputSha256: createHash("sha256").update(listing.description).digest("hex"),
      }),
      providerDetails,
    };
    const [saved] = await db.update(listings).set({
      description, copyProvenance,
      validation: listing.validation.filter((issue) => issue.code !== "supplier_preview_error" && issue.code !== "missing_provider_timings"),
      updatedAt: new Date(),
    })
      .where(snapshotWhere(listing)).returning();
    if (!saved) return unavailable;
    return { ...saved, title: listing.title, tags: listing.tags, priceChf: listing.priceChf };
  } catch (error) {
    const fixed = fixedSupplierError(error);
    return fixed ? { ...unavailable, validation: [...listing.validation.filter((issue) => issue.code !== fixed.code), fixed] } : unavailable;
  }
}

/** Approval prepares supplier proofs only. It never publishes a product to Etsy. */
async function prepareSupplierPreviewInner(db: DB, listing: Listing, opts: { timingsRefreshed?: boolean } = {}) {
  if (listing.productType !== "pod") return { ready: true, listing, error: undefined };
  if (!opts.timingsRefreshed) listing = await refreshSupplierDescription(db, listing);
  let current = listing;
  const waiting: ValidationIssue = {
    field: "image", severity: "error", code: "supplier_mockups_pending", message: WAITING_FOR_PRINTIFY_MOCKUPS,
  };
  try {
    const fixed = listing.validation.find((issue) => issue.code === "supplier_preview_error");
    if (fixed) throw new Error(`${fixed.message}${fixed.message.startsWith("No Printify blank pinned for ") ? "." : ""}`);
    if (validateSupplierApproval(listing).issues.some((issue) => issue.code === "missing_provider_timings")) {
      throw new Error("Verified provider timings are required before creating a supplier product");
    }
    const held = listing.validation.find((issue) => issue.code === "print_file_held");
    if (held) throw new Error(held.message);
    const stale = listing.validation.some((issue) => issue.code === "mockups_stale");
    if (stale && !listing.deliveryUrl) throw new Error("Re-rendered artwork is still upscaling; no print file yet for new mockups");
    const preset = podPresetFromProvider(listing.podProvider);
    if (!preset || (listing.supplier && listing.supplier !== "printify")) throw new Error("A Printify product preset is required");
    let adapter = await getPrintifyAdapter({ db, shopId:listing.shopId, intent: "write" });
    if (listing.isDemo && adapter.mode === "live") throw new Error("Demo artwork cannot create a live supplier product");
    let productId = listing.printifyProductId;
    // Never use a simulated read as proof for an existing real supplier product.
    if (productId && !productId.startsWith("dry-") && adapter.mode === "dry-run") {
      adapter = await getPrintifyAdapter({ db, shopId:listing.shopId, intent: "read" });
      if (adapter.mode !== "live") throw new Error(WAITING_FOR_PRINTIFY_MOCKUPS);
    } else {
      if (adapter.mode === "live" && productId?.startsWith("dry-")) productId = null;
      // The listing's own print file (A3 crop, master, or padded apparel file) wins over the design master.
      let artwork = listing.deliveryUrl;
      if (listing.designId && !artwork) {
        const [design] = await db.select({ imageUrl: designs.imageUrl }).from(designs).where(eq(designs.id, listing.designId));
        artwork = design?.imageUrl ?? artwork;
      }
      if (!artwork && !productId) throw new Error("Print artwork is required");
      const result = await adapter.createAndPublish({
        title: listing.title, description: listing.description, tags: listing.tags, priceChf: listing.priceChf,
        imageUrl: absoluteUrl(artwork ?? listing.imageUrl),
        preset,
        existingProductId: productId ?? undefined, publishToEtsy: false,
      });
      productId = result.productId;
      const [saved] = await db.update(listings).set({
        printifyProductId: productId,
        podBlueprintId: result.blueprintId ?? listing.podBlueprintId,
        podPrintProviderId: result.printProviderId ?? listing.podPrintProviderId,
        publishMode: adapter.mode, updatedAt: new Date(),
      }).where(snapshotWhere(current)).returning();
      if (!saved) return { ready: false, listing: current, error: "Listing changed during supplier preparation. Retry review." };
      current = { ...saved, title: listing.title, description: listing.description, tags: listing.tags, priceChf: listing.priceChf };
    }
    const images = await adapter.getProductImages?.(productId) ?? [];
    const source = adapter.mode === "live" ? "supplier" : "synthetic";
    const supplierViews: ArtworkGalleryView[] = [...new Set(images.map((image) => image.src.trim()).filter(Boolean))]
      .slice(0, 10).map((url, index) => ({
        url, role: "product-mockup", source,
        label: source === "supplier" ? `Printify supplier mockup ${index + 1}` : `Synthetic demo Printify mockup ${index + 1}; not supplier proof`,
      }));
    const seen = new Set(supplierViews.map((view) => view.url));
    const illustrative = (listing.gallery ?? []).filter((view) => view.source !== "supplier" && view.source !== "synthetic" && !seen.has(view.url))
      .map((view) => ({ ...view, source: "illustrative" as const }));
    const gallery = [...supplierViews, ...illustrative].slice(0, 10);
    const ready = supplierMockupCount({ gallery, publishMode: adapter.mode, isDemo: listing.isDemo }) >= MIN_SUPPLIER_MOCKUPS;
    // Fresh Printify mockups of the current print file clear the stale-mockup flag.
    const validation = listing.validation.filter((issue) => issue.code !== waiting.code && issue.code !== "supplier_preview_error" && !(ready && issue.code === "mockups_stale"));
    const [saved] = await db.update(listings).set({
      gallery, ...(supplierViews[0] ? { imageUrl: supplierViews[0].url } : {}),
      publishMode: adapter.mode,
      validation: ready ? validation : [...validation, waiting],
      ...(!ready ? { status: "pending_approval" as const, approvedAt: null } : {}),
      updatedAt: new Date(),
    }).where(snapshotWhere(current)).returning();
    if (!saved) return { ready: false, listing: current, error: "Listing changed during supplier preparation. Retry review." };
    return { ready, listing: saved, error: ready ? undefined : WAITING_FOR_PRINTIFY_MOCKUPS };
  } catch (error) {
    const failure = fixedSupplierError(error) ?? waiting;
    const [saved] = await db.update(listings).set({
      status: "pending_approval", approvedAt: null,
      validation: [...current.validation.filter((issue) => issue.code !== waiting.code && issue.code !== "supplier_preview_error"), failure],
      updatedAt: new Date(),
    }).where(snapshotWhere(current)).returning();
    return { ready: false, listing: saved ?? current, error: failure.message };
  }
}

export async function prepareSupplierPreview(db:DB,listing:Listing,opts:{timingsRefreshed?:boolean}={}) {
  return withOperationLease(db,`listing:${listing.id}`,()=>prepareSupplierPreviewInner(db,listing,opts));
}
