"use client";
import { clip } from "@/lib/brain/quicksearch";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
const Graph3D = dynamic(() => import("./Graph3DInner"), { ssr: false, loading: () => <div className="graph-loading"><div className="pulse-orb" />Igniting the 3D brain…</div> });
const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), { ssr: false, loading: () => <div className="empty" style={{ border: 0, marginTop: 120 }}>Laying out the brain…</div> });
type N = { id: string; name: string; kind: string; tags: string[]; status: string; x?: number; y?: number; deg?: number };
type L = { source: string | N; target: string | N; kind?: string };
const COLORS: Record<string, string> = { reel: "#2dd4bf", idea: "#fbbf24", summary: "#a78bfa", home: "#fb7185", tag: "#64748b" };
const href = (id: string) => "/brain/note/" + id.split("/").map(encodeURIComponent).join("/");
const sid = (x: string | N) => (typeof x === "string" ? x : x.id);

export default function Graph({ data }: { data: { nodes: N[]; links: { source: string; target: string; kind: string }[] } }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fg = useRef<any>(null);
  const box = useRef<HTMLDivElement>(null); const fitted = useRef(false);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [kinds, setKinds] = useState<Record<string, boolean>>({ reel: true, idea: true, summary: true, home: true, tag: true });
  const [tag, setTag] = useState(""); const [status, setStatus] = useState(""); const [q, setQ] = useState(""); const [orphans, setOrphans] = useState(false);
  const [mode, setMode] = useState<"3d" | "2d">("3d"); const [fly, setFly] = useState<string | null>(null);
  useEffect(() => { if (window.innerWidth < 720 || !window.WebGLRenderingContext) setMode("2d"); }, []);
  const [hover, setHover] = useState<N | null>(null); const [sel, setSel] = useState<N | null>(null);

  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(box.current); return () => ro.disconnect();
  }, []);
  const tags = useMemo(() => [...new Set(data.nodes.filter((n) => n.kind !== "tag").flatMap((n) => n.tags))].sort(), [data]);
  const statuses = useMemo(() => [...new Set(data.nodes.map((n) => n.status).filter(Boolean))].sort(), [data]);
  const graph = useMemo(() => {
    const nodes = data.nodes.filter((n) => kinds[n.kind] && (!tag || n.tags.includes(tag) || n.kind === "tag") && (!status || n.status === status)).map((n) => ({ ...n, deg: 0 }));
    const ids = new Map(nodes.map((n) => [n.id, n]));
    const links = data.links.filter((l) => ids.has(l.source) && ids.has(l.target)).map((l) => ({ ...l }));
    for (const l of links) { ids.get(l.source)!.deg!++; ids.get(l.target)!.deg!++; }
    const n2 = nodes.filter((n) => (n.kind !== "tag" || n.deg! > 0) && (orphans || n.deg! > 0 || n.kind === "home"));
    return { nodes: n2, links };
  }, [data, kinds, tag, status, orphans]);
  const neighbors = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const l of graph.links as L[]) { const a = sid(l.source), b = sid(l.target);
      (m.get(a) || m.set(a, new Set()).get(a)!).add(b); (m.get(b) || m.set(b, new Set()).get(b)!).add(a); }
    return m;
  }, [graph]);
  const focus = hover || sel;
  const lit = useCallback((id: string) => !focus || id === focus.id || !!neighbors.get(focus.id)?.has(id), [focus, neighbors]);

  useEffect(() => { fitted.current = false; const t = setTimeout(() => fg.current?.zoomToFit(600, 50), 1200); return () => clearTimeout(t); }, [graph]);
  useEffect(() => { fg.current?.d3Force("charge")?.strength(-55); fg.current?.d3Force("link")?.distance((l: L) => (l.kind === "tag" ? 46 : 30)).strength((l: L) => (l.kind === "tag" ? 0.12 : 0.6)); }, [graph]);

  const jump = (e: React.FormEvent) => {
    e.preventDefault();
    const t = q.toLowerCase(); const n = (graph.nodes as N[]).find((x) => x.name.toLowerCase().includes(t));
    if (n) { setSel(n); setFly(n.id); if (mode === "2d" && n.x != null) { fg.current?.centerAt(n.x, n.y, 700); fg.current?.zoom(3.2, 700); } }
  };
  const counts = useMemo(() => Object.fromEntries(Object.keys(COLORS).map((k) => [k, data.nodes.filter((n) => n.kind === k).length])), [data]);

  return (
    <div>
      <div className="filters">
        <form onSubmit={jump} className="grow" style={{ display: "flex", gap: 8 }}><input style={{ flex: 1 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a note and fly to it…" list="gnodes" aria-label="Find node" />
          <datalist id="gnodes">{data.nodes.slice(0, 400).map((n) => <option key={n.id} value={n.name} />)}</datalist></form>
        <select value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Tag"><option value="">All tags</option>{tags.map((t) => <option key={t}>{t}</option>)}</select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status"><option value="">All statuses</option>{statuses.map((t) => <option key={t}>{t}</option>)}</select>
        <label className="small muted row" style={{ gap: 6 }}><input type="checkbox" checked={orphans} onChange={(e) => setOrphans(e.target.checked)} /> Show unlinked</label>
        <div className="seg">{(["3d", "2d"] as const).map((m) => <button key={m} className={mode === m ? "on" : ""} onClick={() => setMode(m)}>{m.toUpperCase()}</button>)}</div>
        {mode === "2d" && <button className="btn-ghost small" onClick={() => fg.current?.zoomToFit(500, 60)}>Fit</button>}
      </div>
      <div className="card graph-box" ref={box}>
        {graph.nodes.length === 0 ? <div className="empty" style={{ margin: 80 }}>No notes match these filters.</div> : mode === "3d" ?
        <Graph3D graph={graph as never} width={size.w} height={size.h} focusId={sel?.id || null} neighbors={neighbors} flyTo={fly} onSelect={(n) => { if (n && n.kind === "tag") { window.location.href = "/brain/reels?tag=" + encodeURIComponent((n as N).tags?.[0] || n.name.slice(1)); return; } if (n && sel?.id === n.id) { window.location.href = href(n.id); return; } setSel(n as N | null); setFly(n?.id || null); }} /> :
        <ForceGraph2D ref={fg} graphData={graph} width={size.w} height={size.h} backgroundColor="rgba(0,0,0,0)"
          warmupTicks={60} cooldownTicks={180} d3VelocityDecay={0.32} d3AlphaDecay={0.025} enableNodeDrag
          nodeRelSize={4} nodeVal={(n: object) => { const x = n as N; return (x.kind === "reel" ? 1 : 3) + (x.deg || 0) * 0.35; }}
          linkColor={(l: object) => { const x = l as L; const on = focus && (sid(x.source) === focus.id || sid(x.target) === focus.id); return on ? "rgba(139,157,255,.75)" : focus ? "rgba(120,130,160,.04)" : x.kind === "tag" ? "rgba(100,116,139,.10)" : "rgba(160,170,210,.28)"; }}
          linkWidth={(l: object) => { const x = l as L; return focus && (sid(x.source) === focus.id || sid(x.target) === focus.id) ? 1.6 : 0.6; }}
          linkDirectionalParticles={(l: object) => { const x = l as L; return focus && (sid(x.source) === focus.id || sid(x.target) === focus.id) ? 2 : 0; }}
          linkDirectionalParticleWidth={2} linkDirectionalParticleColor={() => "#8b9dff"}
          nodeCanvasObject={(n: object, ctx: CanvasRenderingContext2D, scale: number) => {
            const x = n as N; const r = Math.sqrt((x.kind === "reel" ? 1 : 3) + (x.deg || 0) * 0.35) * 4; const on = lit(x.id); const c = COLORS[x.kind] || "#888";
            ctx.globalAlpha = on ? 1 : 0.12;
            if (focus?.id === x.id) { ctx.beginPath(); ctx.arc(x.x!, x.y!, r + 4, 0, 2 * Math.PI); ctx.fillStyle = c + "33"; ctx.fill(); }
            ctx.beginPath(); ctx.arc(x.x!, x.y!, r, 0, 2 * Math.PI); ctx.fillStyle = c; ctx.shadowColor = c; ctx.shadowBlur = on ? 8 : 0; ctx.fill(); ctx.shadowBlur = 0;
            const showLabel = x.kind === "idea" || x.kind === "summary" || x.kind === "home" ? scale > 0.8 : x.kind === "tag" ? scale > 1.4 : scale > 2.6; 
            if ((showLabel && on) || focus?.id === x.id) {
              const fs = Math.max(10 / scale, 2.2); ctx.font = `${x.kind === "reel" ? 400 : 600} ${fs}px Inter, system-ui, sans-serif`;
              ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.fillStyle = x.kind === "tag" ? "rgba(148,163,184,.85)" : "rgba(232,236,246,.92)";
              const label = x.name.length > 38 ? clip(x.name, 36) + "…" : x.name; ctx.fillText(label, x.x!, x.y! + r + 2 / scale);
            }
            ctx.globalAlpha = 1;
          }}
          nodePointerAreaPaint={(n: object, color: string, ctx: CanvasRenderingContext2D) => { const x = n as N; ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x.x!, x.y!, 8, 0, 2 * Math.PI); ctx.fill(); }}
          onNodeHover={(n: object | null) => { setHover((n as N) || null); if (box.current) box.current.style.cursor = n ? "pointer" : "grab"; }}
          onNodeClick={(n: object) => { const x = n as N; if (x.kind === "tag") { window.location.href = "/brain/reels?tag=" + encodeURIComponent(x.tags[0]); return; } if (sel?.id === x.id) window.location.href = href(x.id); else { setSel(x); fg.current?.centerAt(x.x, x.y, 500); } }}
          onBackgroundClick={() => setSel(null)} onEngineStop={() => { if (!fitted.current) { fitted.current = true; fg.current?.zoomToFit(600, 50); } }} />}
        <div className="legend">{Object.entries(COLORS).map(([k, c]) => <label key={k} className="row" style={{ gap: 5, cursor: "pointer" }}>
          <input type="checkbox" checked={kinds[k]} onChange={(e) => setKinds({ ...kinds, [k]: e.target.checked })} style={{ accentColor: c }} />
          <span className="dot" style={{ background: c }} />{k} <span className="faint">{counts[k]}</span></label>)}</div>
        {sel && <div className="card focus-card">
          <div className="xs" style={{ color: COLORS[sel.kind] }}>● {sel.kind}{sel.status ? " · " + sel.status : ""}</div>
          <div style={{ fontWeight: 600, margin: "4px 0 8px" }}>{sel.name}</div>
          <div className="xs muted" style={{ marginBottom: 10 }}>{neighbors.get(sel.id)?.size || 0} connections</div>
          <div className="row"><Link href={href(sel.id)} className="btn-primary" style={{ padding: "7px 12px", borderRadius: 9, color: "#fff", fontSize: 13 }}>Open note</Link><button className="btn-ghost small" onClick={() => setSel(null)}>Close</button></div>
        </div>}
      </div>
      <div className="xs faint" style={{ marginTop: 8 }}>{graph.nodes.length} nodes · {graph.links.length} links · {mode === "3d" ? "drag to orbit, scroll to zoom, click a node to fly to it, click again to open." : "hover to highlight neighbours, click to select, click again to open, scroll to zoom."}</div>
    </div>
  );
}
