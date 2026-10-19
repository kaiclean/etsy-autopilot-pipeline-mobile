"use client";
import { clip } from "@/lib/brain/quicksearch";
import Link from "next/link";
import { useDeferredValue, useMemo, useState, Fragment } from "react";
import type { IndexDoc } from "@/lib/brain/vault";
import ReelCard from "./ReelCard";
type Facets = { author?: string; lang?: string; tag?: string; collection?: string; kind?: string; from?: string; to?: string };
const href = (id: string) => "/brain/note/" + id.split("/").map(encodeURIComponent).join("/");
const KIND_COLOR: Record<string, string> = { reel: "var(--reel)", idea: "var(--idea)", summary: "var(--summary)", home: "var(--home)" };

function score(d: IndexDoc & { _t: string; _x: string }, terms: string[]): number {
  let s = 0;
  for (const t of terms) {
    const inT = d._t.includes(t), inX = d._x.includes(t);
    if (!inT && !inX) return 0;
    s += (inT ? 10 : 0) + (inX ? 1 + Math.min(d._x.split(t).length - 1, 5) * 0.3 : 0);
  }
  return s;
}
function snippet(text: string, terms: string[]): string {
  if (!terms.length) return "";
  const lo = text.toLowerCase(); const i = lo.indexOf(terms[0]);
  if (i < 0) return "";
  const a = Math.max(0, i - 70); return (a ? "…" : "") + text.slice(a, i + 150) + "…";
}
function Hl({ text, terms }: { text: string; terms: string[] }) {
  if (!text) return null;
  if (!terms.length) return <>{text}</>;
  const re = new RegExp("(" + terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "gi");
  return <>{text.split(re).map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : <Fragment key={i}>{p}</Fragment>))}</>;
}

export default function SearchList({ docs, mode, initial = {} as Facets & { q?: string } }: { docs: IndexDoc[]; mode: "reels" | "all"; initial?: Facets & { q?: string } }) {
  const [q, setQ] = useState(initial.q || "");
  const [more, setMore] = useState(false);
  const [view, setView] = useState<"grid" | "list">(mode === "reels" ? "grid" : "list");
  const [f, setF] = useState<Facets>({ author: initial.author, lang: initial.lang, tag: initial.tag, collection: initial.collection, kind: initial.kind, from: initial.from, to: initial.to });
  const dq = useDeferredValue(q);
  const prepared = useMemo(() => docs.map((d) => ({ ...d, _t: (d.title + " " + d.handle + " " + d.author + " " + d.tags.join(" ")).toLowerCase(), _x: d.text.toLowerCase() })), [docs]);
  const opts = useMemo(() => {
    const u = (fn: (d: IndexDoc) => string[]) => [...new Set(docs.flatMap(fn).filter(Boolean))].sort();
    return { author: u((d) => [d.handle]), lang: u((d) => [d.lang]), tag: u((d) => d.tags), collection: u((d) => [d.collection]), kind: u((d) => [d.kind]) };
  }, [docs]);
  const terms = useMemo(() => dq.toLowerCase().split(/\s+/).filter((t) => t.length > 1), [dq]);
  const results = useMemo(() => {
    const r = prepared.filter((d) => (!f.author || d.handle === f.author) && (!f.lang || d.lang === f.lang) && (!f.tag || d.tags.includes(f.tag))
      && (!f.collection || d.collection === f.collection) && (!f.kind || d.kind === f.kind) && (!f.from || d.date >= f.from) && (!f.to || d.date <= f.to));
    if (!terms.length) return r.sort((a, b) => b.date.localeCompare(a.date)).map((d) => ({ d, s: 1 }));
    return r.map((d) => ({ d, s: score(d, terms) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  }, [prepared, f, terms]);
  const active = Object.values(f).some(Boolean) || q.length > 0;
  const sel = (k: keyof typeof opts, label: string) => (
    <select value={f[k] || ""} onChange={(e) => setF({ ...f, [k]: e.target.value || undefined })} aria-label={label}><option value="">{label}</option>{opts[k].map((o) => <option key={o} value={o}>{o}</option>)}</select>);
  return (
    <>
      <div className="filters">
        <input className="grow" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={mode === "reels" ? "Search captions, summaries, transcripts…" : "Search every note…"} aria-label="Search" />
        <button className={"btn-ghost small only-m" + (more ? " on" : "")} onClick={() => setMore(!more)} aria-expanded={more}>⚙ Filters{Object.values(f).filter(Boolean).length ? ` · ${Object.values(f).filter(Boolean).length}` : null}</button>
        <div className={"more-filters" + (more ? " open" : "")}>
        {mode === "all" && sel("kind", "All types")}
        {sel("tag", "Tag")}
        {mode === "reels" && <>{sel("author", "Author")}{sel("lang", "Language")}{sel("collection", "Collection")}
          <input type="date" value={f.from || ""} onChange={(e) => setF({ ...f, from: e.target.value || undefined })} aria-label="From" />
          <input type="date" value={f.to || ""} onChange={(e) => setF({ ...f, to: e.target.value || undefined })} aria-label="To" /></>}
        </div>
        {active && <button className="btn-ghost small" onClick={() => { setQ(""); setF({}); }}>Clear</button>}
        <div className="seg" role="tablist">{(["grid", "list"] as const).map((v) => <button key={v} className={view === v ? "on" : ""} onClick={() => setView(v)} aria-pressed={view === v}>{v === "grid" ? "▦ Grid" : "☰ List"}</button>)}</div>
      </div>
      <div className="muted xs" style={{ marginBottom: 8 }}>{results.length} of {docs.length} {mode === "reels" ? "reels" : "notes"}</div>
      {results.length === 0 ? (
        <div className="empty"><div className="ico">⌕</div><div style={{ color: "var(--text)", fontWeight: 600 }}>Nothing matches</div><div className="small">Try fewer words or clear the filters.</div></div>
      ) : view === "grid" ? (
        <div className="reel-grid">{results.slice(0, 300).map(({ d }, i) => <ReelCard key={d.id} d={d} i={i}><Hl text={clip(d.title, 90)} terms={terms} /></ReelCard>)}</div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <div className="reel-row reel-head"><div>{mode === "reels" ? "Reel" : "Note"}</div><div className="hide-sm">{mode === "reels" ? "Author" : "Type"}</div><div className="hide-sm">Date</div><div className="hide-sm">Status</div></div>
          {results.slice(0, 300).map(({ d }) => {
            const sn = snippet(d.text, terms);
            return (
              <Link key={d.id} href={href(d.id)} className="reel-row">
                <div style={{ minWidth: 0, display: "flex", gap: 12 }}>{d.thumb && <img src={d.thumb} alt="" className="mini-thumb" loading="lazy" />}<div style={{ minWidth: 0 }}>
                  <div className="t"><Hl text={clip(d.title, 110)} terms={terms} /></div>
                  <div className="snip">{sn ? <Hl text={sn} terms={terms} /> : d.summary}</div>
                  <div style={{ marginTop: 4 }}>{d.tags.filter((t) => t !== "reel" && t !== "idea").slice(0, 4).map((t) => <span key={t} className="pill">{t}</span>)}</div>
                </div></div>
                <div className="hide-sm small muted">{mode === "reels" ? "@" + d.handle : <span style={{ color: KIND_COLOR[d.kind] }}>● {d.kind}</span>}</div>
                <div className="hide-sm small muted">{d.date || "—"}</div>
                <div className="hide-sm"><span className="pill">{d.status || "—"}</span></div>
              </Link>
            );
          })}
        </div>
      )}
    </>
  );
}
