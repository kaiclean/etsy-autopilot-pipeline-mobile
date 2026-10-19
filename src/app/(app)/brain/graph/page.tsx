import { BrainPage as Shell } from "@/components/brain/shell";
import Graph from "@/components/brain/Graph";
import { getVault, graphData } from "@/lib/brain/vault";
export const dynamic = "force-dynamic";
export default function GraphPage() {
  return <Shell><div className="page-head"><div><h2>Brain graph</h2><p>Reels, ideas and summaries, connected by wikilinks and source reels.</p></div></div><Graph data={graphData(getVault())} /></Shell>;
}
