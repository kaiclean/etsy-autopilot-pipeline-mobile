"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { rank, noteHref, searchHref, type QDoc } from "@/lib/brain/quicksearch";
const ITEMS = [
  { href: "/brain", label: "Overview" },
  { href: "/brain/graph", label: "Graph" },
  { href: "/brain/ideas", label: "Ideas" },
  { href: "/brain/reels", label: "Reels" },
  { href: "/brain/insights", label: "Insights" },
  { href: "/brain/timeline", label: "Timeline" },
  { href: "/brain/themes", label: "Themes" },
  { href: "/brain/sessions", label: "Sessions" },
  { href: "/brain/search", label: "Search" },
];
const isActive = (p: string, h: string) => (h === "/brain" ? p === "/brain" : p.startsWith(h));
export function BrainNav() {
  const p = usePathname();
  const navRef = useRef<HTMLElement>(null);
  // On narrow screens the tab row scrolls sideways; keep the current tab visible.
  useEffect(() => { navRef.current?.querySelector<HTMLElement>("a.on")?.scrollIntoView({ block: "nearest", inline: "center" }); }, [p]);
  return (
    <nav ref={navRef} className="bnav" aria-label="Brain sections">
      <span className="brand-mark" aria-hidden>🧠</span>
      {ITEMS.map((i) => <Link key={i.href} href={i.href} className={isActive(p, i.href) ? "on" : ""} aria-current={isActive(p, i.href) ? "page" : undefined}>{i.label}</Link>)}
      <span className="grow" />
      <QuickSearch />
    </nav>
  );
}
function QuickSearch() {
  const r = useRouter(); const ref = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState(""); const [open, setOpen] = useState(false); const [idx, setIdx] = useState(0);
  const [docs, setDocs] = useState<QDoc[] | null>(null); const loading = useRef(false);
  const load = () => { if (docs || loading.current) return; loading.current = true;
    fetch("/api/brain/index", { credentials: "same-origin" }).then((x) => (x.ok ? x.json() : [])).then(setDocs).catch(() => setDocs([])).finally(() => { loading.current = false; }); };
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); ref.current?.focus(); ref.current?.select(); load(); setOpen(true); } };
    window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h);
  });
  const hits = useMemo(() => (docs ? rank(docs, q) : []), [docs, q]);
  const go = (href: string) => { setOpen(false); ref.current?.blur(); r.push(href); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(i + 1, hits.length)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Escape") { setOpen(false); ref.current?.blur(); }
  };
  const showDd = open && q.trim().length > 1;
  const submit = (e: React.FormEvent) => { e.preventDefault(); if (!q.trim()) return;
    go(showDd && idx > 0 && hits[idx - 1] ? noteHref(hits[idx - 1].id) : searchHref(q)); };
  return (
    <form className="qs" onSubmit={submit} role="search">
      <input ref={ref} value={q} onChange={(e) => { setQ(e.target.value); setIdx(0); setOpen(true); }} onFocus={() => { load(); setOpen(true); }}
        onBlur={() => setTimeout(() => setOpen(false), 150)} onKeyDown={onKey}
        placeholder="Search the brain" aria-label="Search the brain" role="combobox" aria-expanded={showDd} aria-controls="qs-dd" autoComplete="off" />
      <span className="kbd">⌘K</span>
      {showDd && (
        <div className="qs-dd" id="qs-dd" role="listbox">
          <a href={searchHref(q)} className={"qs-item qs-all" + (idx === 0 ? " on" : "")} onMouseDown={(e) => { e.preventDefault(); go(searchHref(q)); }}>⌕ Search all for “{q.trim()}”<span className="kbd" style={{ position: "static", transform: "none" }}>↵</span></a>
          {!docs && <div className="qs-empty">Loading…</div>}
          {docs && !hits.length && <div className="qs-empty">No quick matches</div>}
          {hits.map((d, i) => (
            <a key={d.id} href={noteHref(d.id)} className={"qs-item" + (idx === i + 1 ? " on" : "")} onMouseEnter={() => setIdx(i + 1)} onMouseDown={(e) => { e.preventDefault(); go(noteHref(d.id)); }}>
              {d.thumb ? <img src={d.thumb} alt="" /> : <span className={"qs-ico k-" + d.kind}>{d.kind === "idea" ? "✦" : d.kind === "summary" ? "≡" : "●"}</span>}
              <span className="qs-t"><b>{d.title}</b><small>{d.kind}{d.handle ? " · @" + d.handle : ""}{d.date ? " · " + d.date : ""}</small></span>
            </a>
          ))}
        </div>
      )}
    </form>
  );
}
