import { BrainPage as Shell } from "@/components/brain/shell";
import SearchList from "@/components/brain/SearchList";
import { getVault, searchIndex } from "@/lib/brain/vault";
export const dynamic = "force-dynamic";
export default async function Search({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  return (
    <Shell>
      <div className="page-head"><div><h2>Search</h2><p>Reels, ideas and summaries. Results update as you type.</p></div></div>
      <SearchList key={q} docs={searchIndex(getVault())} mode="all" initial={{ q }} />
    </Shell>
  );
}
