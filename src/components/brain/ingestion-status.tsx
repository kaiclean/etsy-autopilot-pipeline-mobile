import Link from "next/link";
import { getDb } from "@/db";
import { ingestionHealth, ingestionStatus } from "@/lib/brain/ingestion";
const LABEL = { "not-connected": "Daily analyser not connected", stalled: "Daily analyser stalled", overdue: "Daily analysis overdue",
  running: "Analysing saved reels", failed: "Daily analysis needs attention", healthy: "Daily saved-reel analysis is up to date" };
export default async function IngestionStatus() {
  const status = await ingestionStatus(await getDb());
  const health = ingestionHealth(status), run = status.lastRun;
  return <section className="card" style={{ marginBottom: 16 }} aria-label="Saved-reel sync status">
    <div className="row between"><h3>{LABEL[health]}</h3><Link href="/brain/setup" className="btn-ghost small">Mac setup →</Link></div>
    <p className="small">{status.lastSuccessAt ? `Last successful check: ${new Date(status.lastSuccessAt).toLocaleString("en-GB", { timeZone: "Europe/Zurich" })} (Zurich).` : "No daily worker has reported a successful check yet. The historical vault is still available."}</p>
    {run && <p className="xs muted">{run.scanned} checked · {run.analysed} analysed · {run.failed} failed · {run.pending} deferred{run.error ? ` · ${run.error.replaceAll("_", " ")}` : ""}</p>}
    {health !== "healthy" && health !== "running" && <p className="xs muted">The daily job runs on your Mac and needs its Instagram sign-in and local models. A stale library does not mean there were no new saves.</p>}
  </section>;
}
