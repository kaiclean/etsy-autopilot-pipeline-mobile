import type { ListingStatus, Niche } from "@/db/schema";

export type QueueStatusFilter = "all" | "ready" | "needs_fixes";

export type QueueFilter = {
  query: string;
  niche: "all" | Niche;
  status: QueueStatusFilter;
};

type QueueRow = {
  title: string;
  tags: string[];
  niche: string;
  validation: { severity: string }[];
};

export function listingHasErrors(validation: { severity: string }[]) {
  return validation.some((issue) => issue.severity === "error");
}

export function filterQueue<T extends QueueRow>(listings: T[], filter: QueueFilter): T[] {
  const query = filter.query.trim().toLowerCase();
  return listings.filter((listing) => {
    if (filter.niche !== "all" && listing.niche !== filter.niche) return false;
    const errors = listingHasErrors(listing.validation);
    if (filter.status === "ready" && errors) return false;
    if (filter.status === "needs_fixes" && !errors) return false;
    if (!query) return true;
    return listing.title.toLowerCase().includes(query) || listing.tags.some((tag) => tag.toLowerCase().includes(query));
  });
}

export type ProductFilter = {
  query: string;
  niche: "all" | Niche;
  status: "all" | ListingStatus;
};

type ProductRow = {
  title: string;
  tags: string[];
  niche: string;
  status: string;
};

export function filterProducts<T extends ProductRow>(listings: T[], filter: ProductFilter): T[] {
  const query = filter.query.trim().toLowerCase();
  return listings.filter((listing) => {
    if (filter.status !== "all" && listing.status !== filter.status) return false;
    if (filter.niche !== "all" && listing.niche !== filter.niche) return false;
    if (!query) return true;
    return listing.title.toLowerCase().includes(query) || listing.tags.some((tag) => tag.toLowerCase().includes(query));
  });
}

export function planBulkStatus(
  rows: { id: number; title: string; hasErrors: boolean }[],
  status: "approved" | "rejected" | "pending_approval",
) {
  const changed: number[] = [];
  const skipped: { id: number; title: string; error: string }[] = [];
  for (const row of rows) {
    if (status === "approved" && row.hasErrors) {
      skipped.push({ id: row.id, title: row.title, error: "Fix validation issues before approving" });
    } else {
      changed.push(row.id);
    }
  }
  return { changed, skipped };
}
