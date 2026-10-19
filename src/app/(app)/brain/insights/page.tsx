import { BrainPage as Shell, Empty } from "@/components/brain/shell";
import { AreaChart, BarList, Donut, Matrix } from "@/components/brain/Charts";
import CountUp from "@/components/brain/CountUp";
import { getVault, noteHref } from "@/lib/brain/vault";
import { latestByIdea } from "@/lib/brain/decisions";
export const dynamic = "force-dynamic";

function isoWeekStart(d: string) { const t = new Date(d + "T00:00:00Z"); const day = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - day); return t.toISOString().slice(0, 10); }
const top = (m: Map<string, number>, n: number) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([label, value]) => ({ label, value }));
const inc = (m: Map<string, number>, k: string, by = 1) => m.set(k, (m.get(k) || 0) + by);

export default async function Insights() {
  const v = getVault();
  const reels = v.notes.filter((n) => n.kind === "reel");
  const ideas = v.notes.filter((n) => n.kind === "idea");
  if (!reels.length) return <Shell><Empty icon="📈" title="No data yet">Insights appear once the vault has reels.</Empty></Shell>;
  const dec = await latestByIdea();
  const weeks = new Map<string, number>(), authors = new Map<string, number>(), tags = new Map<string, number>(), langs = new Map<string, number>(), status = new Map<string, number>(), processed = new Map<string, number>();
  let totalDur = 0;
  for (const r of reels) {
    const d = r.data.date_posted ? String(r.data.date_posted) : "";
    if (d) inc(weeks, isoWeekStart(d));
    if (r.data.date_processed) inc(processed, String(r.data.date_processed));
    if (r.data.author_handle) inc(authors, "@" + r.data.author_handle);
    for (const t of r.tags) if (t !== "reel") inc(tags, t);
    inc(langs, String(r.data.language || "unknown")); inc(status, String(r.data.status || "unknown"));
    totalDur += Number(r.data.duration) || 0;
  }
  // continuous weekly series over the last 26 weeks with data
  const wk = [...weeks.keys()].sort(); const series: { label: string; value: number }[] = [];
  if (wk.length) { const end = new Date(wk[wk.length - 1]); const start = new Date(Math.max(new Date(wk[0]).getTime(), end.getTime() - 25 * 7 * 864e5));
    for (let t = start; t <= end; t = new Date(t.getTime() + 7 * 864e5)) { const k = t.toISOString().slice(0, 10); series.push({ label: k.slice(5).replace("-", "/"), value: weeks.get(k) || 0 }); } }
  const PE: Record<string, number> = { S: 0, M: 1, L: 2 }, PP: Record<string, number> = { low: 0, medium: 1, high: 2 };
  const jitter = new Map<string, number>();
  const matrix = ideas.map((i) => { const x = PE[String(i.data.effort)] ?? 1, y = PP[String(i.data.potential)] ?? 1; const k = `${x}${y}`; const j = jitter.get(k) || 0; jitter.set(k, j + 1);
    return { id: i.id, label: i.title, x: x + ((j % 3) - 1) * 0.22, y: y + (Math.floor(j / 3) - 0.5) * 0.25, r: Math.min(i.links.length, 6) }; });
  const verdicts = new Map<string, number>(); for (const i of ideas) inc(verdicts, dec.get(i.id)?.verdict.replace("_", " ") || "pending");
  const transcribed = reels.filter((r) => /Transcript/.test(r.body) && (r.data.status === "transcribed" || r.data.status === "summarized")).length;
  return (
    <Shell>
      <div className="page-head fade-up"><div><h2>Insights</h2><p>What you&apos;ve been saving, and where the ideas are.</p></div></div>
      <div className="stats">
        <div className="card fade-up glow-reel"><div className="stat-l">Reels saved</div><div className="stat"><CountUp to={reels.length} /></div></div>
        <div className="card fade-up glow-idea" style={{ animationDelay: "60ms" }}><div className="stat-l">Watch time archived</div><div className="stat"><CountUp to={Math.round(totalDur / 60)} />m</div></div>
        <div className="card fade-up" style={{ animationDelay: "120ms" }}><div className="stat-l">Creators</div><div className="stat"><CountUp to={authors.size} /></div></div>
        <div className="card fade-up glow-sum" style={{ animationDelay: "180ms" }}><div className="stat-l">Transcribed</div><div className="stat"><CountUp to={Math.round((transcribed / reels.length) * 100)} />%</div></div>
      </div>
      <div className="card fade-up" style={{ marginBottom: 16 }}><div className="row between"><h3>Reels saved per week (by post date)</h3><span className="xs faint">last {series.length} weeks</span></div><AreaChart data={series} /></div>
      <div className="grid-2">
        <div className="card fade-up"><h3>Top themes</h3><BarList data={top(tags, 12)} color="#8b9dff" hrefFor={(t) => `/brain/reels?tag=${encodeURIComponent(t)}`} /></div>
        <div className="card fade-up"><h3>Top creators</h3><BarList data={top(authors, 12)} color="#2dd4bf" hrefFor={(a) => `/brain/reels?author=${encodeURIComponent(a.slice(1))}`} /></div>
        <div className="card fade-up"><h3>Pipeline status</h3><Donut data={top(status, 8)} colors={["#a78bfa", "#2dd4bf", "#fbbf24", "#fb7185", "#64748b"]} /></div>
        <div className="card fade-up"><h3>Languages</h3><Donut data={top(langs, 8)} colors={["#8b9dff", "#f472b6", "#34d399", "#fbbf24", "#64748b"]} /></div>
        <div className="card fade-up"><h3>Idea map · potential × effort</h3><Matrix items={matrix} href={noteHref} /><div className="xs faint">Bubble size = number of source reels. Top-left is the sweet spot.</div></div>
        <div className="card fade-up"><h3>Decisions</h3><Donut data={top(verdicts, 5)} colors={["#64748b", "#34d399", "#fbbf24", "#f87171"]} /></div>
      </div>
    </Shell>
  );
}
