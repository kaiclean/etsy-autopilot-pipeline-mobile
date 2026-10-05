import type { ListingStatus, Niche, ProductType } from "@/db/schema";

/** Media present and no Etsy listing id. */
export function listingNeedsEtsyId(row: { etsyListingId?: string | null; imageUrl?: string | null }) {
  return !row.etsyListingId && Boolean(row.imageUrl && row.imageUrl.trim());
}

export type QueueStatusFilter = "all" | "ready" | "needs_fixes";
export type QueueTriage = "all" | "needs_etsy_id" | "digital" | "pod" | "title_image_mismatch";

export const QUEUE_TRIAGE: { id: QueueTriage; label: string }[] = [
  { id: "all", label: "All paths" },
  { id: "needs_etsy_id", label: "Needs Etsy id" },
  { id: "digital", label: "Digital" },
  { id: "pod", label: "POD" },
  { id: "title_image_mismatch", label: "Title / image" },
];

export type QueueFilter = {
  query: string;
  niche: "all" | Niche;
  status: QueueStatusFilter;
  triage?: QueueTriage;
};

type QueueRow = {
  title: string;
  tags: string[];
  niche: string;
  validation: { severity: string }[];
  productType?: ProductType | string;
  etsyListingId?: string | null;
  imageUrl?: string | null;
  description?: string | null;
};

const TRIAGE_IDS = new Set<string>(QUEUE_TRIAGE.map((item) => item.id));

export function parseQueueTriage(value: string | string[] | undefined): QueueTriage {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw && TRIAGE_IDS.has(raw)) return raw as QueueTriage;
  return "all";
}

/**
 * Flag only. Title names a mug or sweatshirt while tags, product type, or mockup meta say poster.
 * Does not rewrite the listing.
 */
export function titleImageMismatch(listing: {
  title: string;
  tags?: string[];
  productType?: string | null;
  imageUrl?: string | null;
  description?: string | null;
  mockupMeta?: string | null;
}) {
  if (!/\b(?:mug|sweatshirt)\b/i.test(listing.title)) return false;
  const tags = (listing.tags ?? []).join(" ");
  const productSaysPoster = /\bposter\b/i.test(`${listing.productType ?? ""} ${tags}`);
  const mockupSaysPoster = /\bposter\b/i.test(`${listing.mockupMeta ?? ""} ${listing.imageUrl ?? ""} ${listing.description ?? ""}`);
  return productSaysPoster || mockupSaysPoster;
}

function matchesTriage(
  listing: {
    title: string;
    tags?: string[];
    productType?: string | null;
    etsyListingId?: string | null;
    imageUrl?: string | null;
    description?: string | null;
  },
  triage: QueueTriage,
) {
  if (triage === "all") return true;
  if (triage === "needs_etsy_id") {
    return listingNeedsEtsyId({
      etsyListingId: listing.etsyListingId ?? null,
      imageUrl: listing.imageUrl ?? null,
    });
  }
  if (triage === "digital") return listing.productType === "digital";
  if (triage === "pod") return listing.productType === "pod";
  return titleImageMismatch(listing);
}

export function listingHasErrors(validation: { severity: string }[]) {
  return validation.some((issue) => issue.severity === "error");
}

export function filterQueue<T extends QueueRow>(listings: T[], filter: QueueFilter): T[] {
  const query = filter.query.trim().toLowerCase();
  const triage = filter.triage ?? "all";
  return listings.filter((listing) => {
    if (filter.niche !== "all" && listing.niche !== filter.niche) return false;
    if (!matchesTriage(listing, triage)) return false;
    const errors = listingHasErrors(listing.validation);
    if (filter.status === "ready" && errors) return false;
    if (filter.status === "needs_fixes" && !errors) return false;
    if (!query) return true;
    return listing.title.toLowerCase().includes(query) || listing.tags.some((tag) => tag.toLowerCase().includes(query));
  });
}

type ProductRow = {
  title: string;
  tags: string[];
  niche: string;
  status: string;
  productType?: ProductType | string;
  etsyListingId?: string | null;
  imageUrl?: string | null;
  description?: string | null;
};

export type ProductFilter = {
  query: string;
  niche: "all" | Niche;
  status: "all" | ListingStatus;
  triage?: QueueTriage;
};

export function filterProducts<T extends ProductRow>(listings: T[], filter: ProductFilter): T[] {
  const query = filter.query.trim().toLowerCase();
  const triage = filter.triage ?? "all";
  return listings.filter((listing) => {
    if (filter.status !== "all" && listing.status !== filter.status) return false;
    if (filter.niche !== "all" && listing.niche !== filter.niche) return false;
    if (!matchesTriage(listing, triage)) return false;
    if (!query) return true;
    return listing.title.toLowerCase().includes(query) || listing.tags.some((tag) => tag.toLowerCase().includes(query));
  });
}

export function planBulkStatus(
  rows: { id: number; title: string; hasErrors: boolean; error?: string }[],
  status: "approved" | "rejected" | "pending_approval",
) {
  const changed: number[] = [];
  const skipped: { id: number; title: string; error: string }[] = [];
  for (const row of rows) {
    if (status === "approved" && row.hasErrors) {
      skipped.push({ id: row.id, title: row.title, error: row.error ?? "Fix validation issues before approving" });
    } else {
      changed.push(row.id);
    }
  }
  return { changed, skipped };
}
