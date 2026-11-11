import IngestionStatus from "@/components/brain/ingestion-status";
import { getLiveVault } from "@/lib/brain/live-vault";
import { BrainPage as Shell, Empty } from "@/components/brain/shell";
import SearchList from "@/components/brain/SearchList";
import { searchIndex } from "@/lib/brain/vault";
export const dynamic = "force-dynamic";
export default async function Reels({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const docs = searchIndex((await getLiveVault()), ["reel"]);
  return (
    <Shell>
      <IngestionStatus />
      <div className="page-head"><div><h2>Reels library</h2><p>Saved Instagram videos and their actual analysis status.</p></div></div>
      {docs.length ? <SearchList docs={docs} mode="reels" initial={{ q: sp.q, tag: sp.tag, author: sp.author }} /> : <Empty icon="▶" title="No reels yet">Connect the daily Mac analyser under Daily sync.</Empty>}
    </Shell>
  );
}
