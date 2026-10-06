import { CatalogDraftPanel } from "@/components/catalog-draft-panel";
import { PageHeader } from "@/components/common";
import { ProductsList } from "@/components/products/products-list";
import { getDb } from "@/db";
import { parseQueueTriage } from "@/lib/catalog-filters";
import { resolveUsdToChf } from "@/lib/fee-schedule";
import { getListings } from "@/lib/queries";
import { getSetting } from "@/lib/settings";

export const metadata = { title: "Products" };

export default async function ProductsPage({ searchParams }: { searchParams: Promise<{ triage?: string | string[] }> }) {
  const params = await searchParams;
  const db = await getDb();
  const [listings, automation, catalogDraft, feeFx] = await Promise.all([
    getListings(),
    getSetting(db, "automation"),
    getSetting(db, "catalogDraft"),
    getSetting(db, "feeFx"),
  ]);
  const live = listings.filter((l) => l.status === "published").length;
  const awaiting = listings.filter((l) => l.status === "publishing").length;
  const fx = resolveUsdToChf({ stored: feeFx?.usdToChf, storedAsOf: feeFx?.asOf });
  return (
    <div className="space-y-6">
      <PageHeader
        title="Products"
        subtitle={`${live} published${awaiting ? ` · ${awaiting} awaiting Etsy id` : ""} · ${listings.length} total · badged by source`}
      />
      <CatalogDraftPanel reviewed={catalogDraft.reviewedByKai} />
      <ProductsList
        listings={listings}
        offsiteAds={automation.assumeOffsiteAds}
        usdToChf={fx.rate}
        initialTriage={parseQueueTriage(params.triage)}
      />
    </div>
  );
}
