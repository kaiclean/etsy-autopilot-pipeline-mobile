import { getLiveVault } from "@/lib/brain/live-vault";
import { BrainPage as Shell } from "@/components/brain/shell";
import Graph from "@/components/brain/Graph";
import { graphData } from "@/lib/brain/vault";
export const dynamic = "force-dynamic";
export default async function GraphPage() {
  return <Shell><div className="page-head"><div><h2>Brain graph</h2><p>Reels, ideas and summaries, connected by wikilinks and source reels.</p></div></div><Graph data={graphData((await getLiveVault()))} /></Shell>;
}
