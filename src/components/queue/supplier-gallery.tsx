import { Thumb } from "@/components/common";
import type { Listing } from "@/db/schema";
import { MIN_SUPPLIER_MOCKUPS, supplierMockupCount } from "@/lib/quality-gate";

export function SupplierGallery({ listing }: { listing: Listing }) {
  if (listing.productType !== "pod") return null;
  const count = supplierMockupCount(listing);
  return (
    <section className="space-y-2" aria-label="Supplier preview gallery">
      <p className="text-xs text-muted-foreground">
        {count}/{MIN_SUPPLIER_MOCKUPS} required Printify mockups
        {listing.publishMode === "dry-run" ? " · synthetic demo previews are not live supplier proof" : ""}
      </p>
      <div className="flex gap-2 overflow-x-auto">
        {listing.gallery.map((view) => (
          <figure key={view.url} className="w-24 shrink-0">
            <Thumb src={view.url} alt={view.label} className="size-24" />
            <figcaption className="mt-1 text-[10px] text-muted-foreground">
              {view.source === "supplier" ? "Supplier" : view.source === "synthetic" ? "Synthetic demo" : "Illustrative"} · {view.label}
            </figcaption>
          </figure>
        ))}
      </div>
      {count < MIN_SUPPLIER_MOCKUPS && <p className="text-xs text-warning">Waiting for Printify mockups</p>}
    </section>
  );
}
