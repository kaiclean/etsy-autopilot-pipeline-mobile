import { CatalogDraftPanel } from "@/components/catalog-draft-panel";
import { PageHeader } from "@/components/common";
import { ProductsList } from "@/components/products/products-list";
import { getDb } from "@/db";
import { parseQueueTriage } from "@/lib/catalog-filters";
import { getListings } from "@/lib/queries";
import { getSetting } from "@/lib/settings";
import Link from "next/link";

export const metadata = { title: "Products" };

export default async function ProductsPage({ searchParams }: { searchParams: Promise<{ triage?: string | string[] }> }) {
  const params = await searchParams;
  const [listings, catalogDraft] = await Promise.all([getListings(), getDb().then((db) => getSetting(db, "catalogDraft"))]);
  const live = listings.filter((l) => l.status === "published").length;
  const awaiting = listings.filter((l) => l.status === "publishing").length;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Products"
        subtitle={`${live} published${awaiting ? ` · ${awaiting} awaiting Etsy id` : ""} · ${listings.length} total · badged by source`}
      />
      <CatalogDraftPanel reviewed={catalogDraft.reviewedByKai} />
      <Link href="/products/sourcing" className="text-sm underline">Compare suppliers · stock, costs, shipping, production time</Link>
      <ProductsList listings={listings} initialTriage={parseQueueTriage(params.triage)} />
    </div>
  );
}
