import { clip } from "@/lib/brain/quicksearch";
import Link from "next/link";
import { BrainPage as Shell, Empty } from "@/components/brain/shell";
import { getVault, noteHref, searchIndex } from "@/lib/brain/vault";
import ReelCard from "@/components/brain/ReelCard";
import CountUp from "@/components/brain/CountUp";
import { latestByIdea } from "@/lib/brain/decisions";
export const dynamic = "force-dynamic";
const POT: Record<string, number> = { high: 3, medium: 2, low: 1 };
const fmt = (d: string | Date) => new Date(d).toLocaleString("en-GB", { timeZone: "Europe/Zurich", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const VERDICT: Record<string, string> = { approved: "ok", rejected: "bad", needs_research: "res" };

function Stat({ label, value, color, sub, href }: { label: string; value: number; color: string; sub?: string; href?: string }) {
  return (
    <Link href={href || "#"} className="card hover" style={{ color: "inherit" }}>
      <div className="stat-l"><span className="dot" style={{ background: color }} />{label}</div>
      <div className="stat"><CountUp to={value} /></div>{sub && <div className="xs muted">{sub}</div>}
    </Link>);
}

export default async function Overview() {
  const v = getVault();
  const reels = v.notes.filter((n) => n.kind === "reel");
  const ideas = v.notes.filter((n) => n.kind === "idea");
  const dec = await latestByIdea();
  const pending = ideas.filter((i) => !dec.has(i.id) || dec.get(i.id)!.verdict === "needs_research");
  const byStatus: Record<string, number> = {};
  for (const i of ideas) { const s = String(i.data.status || "idea"); byStatus[s] = (byStatus[s] || 0) + 1; }
  const reelStatus: Record<string, number> = {};
  for (const r of reels) { const s = String(r.data.status || "?"); reelStatus[s] = (reelStatus[s] || 0) + 1; }
  const tagCount = new Map<string, number>();
  for (const r of reels) for (const t of r.tags) if (t !== "reel") tagCount.set(t, (tagCount.get(t) || 0) + 1);
  const themes = [...tagCount].sort((a, b) => b[1] - a[1]).slice(0, 24);
  const maxTag = themes[0]?.[1] || 1;
  const d = (n: { data: Record<string, unknown> }) => (n.data.date_posted ? String(n.data.date_posted) : "");
  const latest = [...reels].filter((r) => d(r)).sort((a, b) => d(b).localeCompare(d(a))).slice(0, 7);
  const top = [...ideas].sort((a, b) => (POT[String(b.data.potential)] || 0) - (POT[String(a.data.potential)] || 0) || b.links.length - a.links.length).slice(0, 6);
  const recent = [...dec.values()].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 6);
  return (
    <Shell>
      <div className="page-head"><div><h2>Command center</h2><p>{reels.length} reels distilled into {ideas.length} ideas for Designed by Kai.</p></div></div>
      <div className="stats">
        <Stat label="Reels" value={reels.length} color="var(--reel)" href="/brain/reels" sub={Object.entries(reelStatus).map(([k, n]) => `${n} ${k}`).join(" · ")} />
        <Stat label="Ideas" value={ideas.length} color="var(--idea)" href="/brain/ideas" sub={Object.entries(byStatus).map(([k, n]) => `${n} ${k}`).join(" · ")} />
        <Stat label="Awaiting your call" value={pending.length} color="var(--accent)" href="/brain/ideas" sub={"Approve, reject or research"} />
        <Stat label="Links in the graph" value={v.notes.reduce((s, n) => s + n.links.length, 0)} color="var(--summary)" href="/brain/graph" sub={`${v.notes.filter((n) => n.kind === "summary").length} summaries`} />
      </div>
      {(() => { const fresh = searchIndex(v, ["reel"]).filter((x) => x.thumb && x.date).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 12);
        return fresh.length ? <div className="card" style={{ marginBottom: 16 }}><div className="row between"><h3>Fresh in the brain</h3><Link href="/brain/timeline" className="xs">Timeline →</Link></div><div className="strip">{fresh.map((d, i) => <ReelCard key={d.id} d={d} i={i} />)}</div></div> : null; })()}
      <div className="grid-2">
        <div className="card"><div className="row between"><h3>Latest reels</h3><Link href="/brain/reels" className="xs">All reels →</Link></div>
          {latest.length ? latest.map((r) => <Link key={r.id} href={noteHref(r.id)} className="list-item"><div className="t">{r.title}</div><div className="xs muted">{[r.data.author_handle ? "@" + r.data.author_handle : "", d(r), String(r.data.status || "")].filter(Boolean).join(" · ")}</div></Link>) : <Empty icon="▶" title="No reels yet" />}
        </div>
        <div className="card"><div className="row between"><h3>Top ideas</h3><Link href="/brain/ideas" className="xs">Board →</Link></div>
          {top.length ? top.map((i) => <Link key={i.id} href={noteHref(i.id)} className="list-item"><div className="row between"><div className="t">{i.title}</div>{dec.get(i.id) && <span className={"pill " + VERDICT[dec.get(i.id)!.verdict]}>{dec.get(i.id)!.verdict.replace("_", " ")}</span>}</div>
            <div><span className={"pill" + (i.data.potential === "high" ? " hi" : "")}>{String(i.data.potential)} potential</span><span className="pill">effort {String(i.data.effort)}</span><span className="pill">{String(i.data.type)}</span></div></Link>) : <Empty icon="✦" title="No ideas yet" />}
        </div>
        <div className="card"><h3>Themes</h3>
          {themes.length ? <div>{themes.map(([t, n]) => <Link key={t} href={`/brain/reels?tag=${encodeURIComponent(t)}`} className="pill" style={{ fontSize: 11 + Math.round((n / maxTag) * 4), opacity: 0.6 + (n / maxTag) * 0.4 }}>{t} <span className="faint">{n}</span></Link>)}</div> : <Empty title="No tags yet" />}
        </div>
        <div className="card"><h3>Recent decisions</h3>
          {recent.length ? recent.map((d) => <Link key={d.id} href={noteHref(d.idea_id)} className="list-item"><div className="row between"><div className="t">{d.idea_id.split("/").pop()}</div><span className={"pill " + VERDICT[d.verdict]}>{d.verdict.replace("_", " ")}</span></div><div className="xs muted">{fmt(d.created_at)} (Zurich){d.comment ? " · " + clip(d.comment, 80) : ""}</div></Link>)
            : <Empty icon="✓" title="No decisions yet"><>Review ideas in the <Link href="/brain/ideas">approval queue</Link>.</></Empty>}
        </div>
      </div>
    </Shell>
  );
}
