import type { Listing } from "@/db/schema";

/** Where a row came from. Demo wins over dry-run so seeded Neon rows are never read as shop sales. */
export type ProvenanceKind = "demo" | "dry-run" | "live";

export const PROVENANCE_LABEL: Record<ProvenanceKind, string> = {
  demo: "Demo",
  "dry-run": "Dry-run draft",
  live: "Live Etsy",
};

export const PROVENANCE_HINT: Record<ProvenanceKind, string> = {
  demo: "Seeded demo row. Not a live shop sale.",
  "dry-run": "Created while publishing is dry-run. Nothing was sent to live Etsy.",
  live: "Linked to a live Etsy listing or receipt.",
};

type ListingSource = Pick<Listing, "isDemo" | "publishMode" | "etsyListingId">;

export function listingProvenance(row: ListingSource): ProvenanceKind {
  if (row.isDemo) return "demo";
  const id = row.etsyListingId ?? "";
  const synthetic = id.length === 0 || id.startsWith("dry-");
  if (row.publishMode === "live" && !synthetic) return "live";
  return "dry-run";
}

export function orderProvenance(row: { isDemo: boolean; etsyReceiptId: string }): ProvenanceKind {
  if (row.isDemo || row.etsyReceiptId.startsWith("demo-")) return "demo";
  if (row.etsyReceiptId.startsWith("dry-")) return "dry-run";
  return "live";
}
