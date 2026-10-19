import { BrainPage as Shell, Empty } from "@/components/brain/shell";
import SearchList from "@/components/brain/SearchList";
import { getVault, searchIndex } from "@/lib/brain/vault";
export const dynamic = "force-dynamic";
export default async function Reels({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const docs = searchIndex(getVault(), ["reel"]);
  return (
    <Shell>
      <div className="page-head"><div><h2>Reels library</h2><p>Every saved Instagram post, transcribed and summarized.</p></div></div>
      {docs.length ? <SearchList docs={docs} mode="reels" initial={{ q: sp.q, tag: sp.tag, author: sp.author }} /> : <Empty icon="▶" title="No reels yet">Run the OmniGram pipeline, then re-sync the vault.</Empty>}
    </Shell>
  );
}
