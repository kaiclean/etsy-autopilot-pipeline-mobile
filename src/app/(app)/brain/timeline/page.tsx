import Link from "next/link";
import { BrainPage as Shell, Empty } from "@/components/brain/shell";
import { getVault, noteHref, thumbFor, Note } from "@/lib/brain/vault";
export const dynamic = "force-dynamic";
type Ev = { date: string; note: Note; kind: "reel" | "idea" };
const MONTH = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const DAY = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

export default async function Timeline({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  const { show = "all" } = await searchParams;
  const v = getVault();
  const evs: Ev[] = [];
  for (const n of v.notes) {
    if (n.kind === "reel" && n.data.date_posted && show !== "ideas") evs.push({ date: String(n.data.date_posted), note: n, kind: "reel" });
    if (n.kind === "idea" && n.data.created && show !== "reels") evs.push({ date: String(n.data.created), note: n, kind: "idea" });
  }
  evs.sort((a, b) => b.date.localeCompare(a.date) || (a.kind === "idea" ? -1 : 1));
  const months = new Map<string, Ev[]>();
  for (const e of evs) { const k = e.date.slice(0, 7); (months.get(k) || months.set(k, []).get(k)!).push(e); }
  return (
    <Shell>
      <div className="page-head fade-up"><div><h2>Timeline</h2><p>When the reels were posted and when ideas were born.</p></div>
        <div className="seg">{["all", "reels", "ideas"].map((s) => <Link key={s} href={`/brain/timeline?show=${s}`} className={show === s ? "on" : ""}>{s}</Link>)}</div></div>
      {!evs.length ? <Empty icon="🕰" title="Nothing on the timeline yet" /> :
        <div className="timeline">
          {[...months].map(([m, list]) => (
            <section key={m} className="tl-month">
              <div className="tl-month-h"><span>{MONTH(m + "-01")}</span><span className="pill">{list.length}</span></div>
              {list.map((e, i) => {
                const th = e.kind === "reel" ? thumbFor(e.note) : null;
                return (
                  <Link key={e.note.id + e.kind} href={noteHref(e.note.id)} className={"tl-item fade-up tl-" + e.kind} style={{ animationDelay: `${Math.min(i, 12) * 35}ms` }}>
                    <span className="tl-dot" />
                    <span className="tl-date">{DAY(e.date)}</span>
                    <div className="tl-card">
                      {th ? <img src={th} alt="" loading="lazy" className="tl-thumb" /> : <div className="tl-icon">{e.kind === "idea" ? "✦" : "▶"}</div>}
                      <div style={{ minWidth: 0 }}>
                        <div className="tl-title">{e.note.title}</div>
                        <div className="xs muted">{e.kind === "idea" ? `New idea · ${e.note.data.potential} potential · effort ${e.note.data.effort}` : `@${e.note.data.author_handle || "unknown"} · ${e.note.data.status}`}</div>
                      </div>
                    </div>
                  </Link>
                );
              })}
            </section>
          ))}
        </div>}
    </Shell>
  );
}
