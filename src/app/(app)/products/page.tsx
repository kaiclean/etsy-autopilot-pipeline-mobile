import { PageHeader } from "@/components/common";
import { ProductsList } from "@/components/products/products-list";
import { getListings } from "@/lib/queries";

export const metadata = { title: "Products" };

export default async function ProductsPage() {
  const listings = await getListings();
  const live = listings.filter((l) => l.status === "published").length;
  const awaiting = listings.filter((l) => l.status === "publishing").length;
  return (
    <div>
      <PageHeader
        title="Products"
        subtitle={`${live} published${awaiting ? ` · ${awaiting} awaiting Etsy id` : ""} · ${listings.length} total · badged by source`}
      />
      <ProductsList listings={listings} />
    </div>
  );
}
