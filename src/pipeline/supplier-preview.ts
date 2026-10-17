import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { getPrintifyAdapter } from "@/adapters/printify";
import type { DB } from "@/db";
import { designs, listings, type Listing, type ValidationIssue } from "@/db/schema";
import { publicAppUrl } from "@/lib/config";
import { appendProviderDetails, validProviderDetails } from "@/lib/disclosures";
import { MIN_SUPPLIER_MOCKUPS, podPresetFromProvider, supplierMockupCount, WAITING_FOR_PRINTIFY_MOCKUPS } from "@/lib/quality-gate";
import type { ArtworkGalleryView } from "./mockup";

export { WAITING_FOR_PRINTIFY_MOCKUPS };

function absoluteUrl(url: string) {
  return new URL(url, `${publicAppUrl()}/`).toString();
}

/** Replace timing claims with current provider facts before copy validation. */
export async function refreshSupplierDescription(db: DB, listing: Listing): Promise<Listing> {
  if (listing.productType !== "pod") return listing;
  const preset = podPresetFromProvider(listing.podProvider);
  if (!preset || (listing.supplier && listing.supplier !== "printify")) return listing;
  try {
    const adapter = await getPrintifyAdapter({ db, intent: "read" });
    if (adapter.mode === "dry-run" && listing.printifyProductId && !listing.printifyProductId.startsWith("dry-")) return listing;
    const providerDetails = await adapter.getProviderDetails?.(preset);
    if (!validProviderDetails(providerDetails)) return listing;
    const description = appendProviderDetails(listing.description, providerDetails);
    const copyProvenance = {
      ...(listing.copyProvenance ?? {
        version: 1 as const, provider: "supplier-preview",
        inputSha256: createHash("sha256").update(listing.description).digest("hex"),
      }),
      providerDetails,
    };
    const [saved] = await db.update(listings).set({ description, copyProvenance, updatedAt: new Date() })
      .where(eq(listings.id, listing.id)).returning();
    return { ...saved, title: listing.title, tags: listing.tags, priceChf: listing.priceChf };
  } catch {
    return listing;
  }
}

/** Approval prepares supplier proofs only. It never publishes a product to Etsy. */
export async function prepareSupplierPreview(db: DB, listing: Listing) {
  if (listing.productType !== "pod") return { ready: true, listing };
  let current = listing;
  const waiting: ValidationIssue = {
    field: "image", severity: "error", code: "supplier_mockups_pending", message: WAITING_FOR_PRINTIFY_MOCKUPS,
  };
  try {
    const preset = podPresetFromProvider(listing.podProvider);
    if (!preset || (listing.supplier && listing.supplier !== "printify")) throw new Error("A Printify product preset is required");
    let adapter = await getPrintifyAdapter({ db, intent: "write" });
    if (listing.isDemo && adapter.mode === "live") throw new Error("Demo artwork cannot create a live supplier product");
    let productId = listing.printifyProductId;
    // Never use a simulated read as proof for an existing real supplier product.
    if (productId && !productId.startsWith("dry-") && adapter.mode === "dry-run") {
      adapter = await getPrintifyAdapter({ db, intent: "read" });
      if (adapter.mode !== "live") throw new Error(WAITING_FOR_PRINTIFY_MOCKUPS);
    } else {
      if (adapter.mode === "live" && productId?.startsWith("dry-")) productId = null;
      let artwork = listing.deliveryUrl;
      if (listing.designId) {
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
      }).where(eq(listings.id, listing.id)).returning();
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
    const ready = supplierMockupCount({ gallery, publishMode: adapter.mode }) >= MIN_SUPPLIER_MOCKUPS;
    const validation = listing.validation.filter((issue) => issue.code !== waiting.code);
    const [saved] = await db.update(listings).set({
      gallery, ...(supplierViews[0] ? { imageUrl: supplierViews[0].url } : {}),
      publishMode: adapter.mode,
      validation: ready ? validation : [...validation, waiting],
      ...(!ready ? { status: "pending_approval" as const, approvedAt: null } : {}),
      updatedAt: new Date(),
    }).where(eq(listings.id, listing.id)).returning();
    return { ready, listing: saved };
  } catch {
    const [saved] = await db.update(listings).set({
      status: "pending_approval", approvedAt: null,
      validation: [...current.validation.filter((issue) => issue.code !== waiting.code), waiting],
      updatedAt: new Date(),
    }).where(eq(listings.id, listing.id)).returning();
    return { ready: false, listing: saved };
  }
}
