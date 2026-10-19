"use client";
import { clip } from "@/lib/brain/quicksearch";
import ForceGraph3D from "react-force-graph-3d";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import SpriteText from "three-spritetext";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";

type N = { id: string; name: string; kind: string; deg?: number; x?: number; y?: number; z?: number };
type L = { source: string | N; target: string | N; kind?: string };
const COLORS: Record<string, string> = { reel: "#2dd4bf", idea: "#fbbf24", summary: "#a78bfa", home: "#fb7185", tag: "#64748b" };
const sid = (x: string | N) => (typeof x === "string" ? x : x.id);

export default function Graph3DInner({ graph, width, height, focusId, neighbors, onSelect, flyTo }: {
  graph: { nodes: N[]; links: L[] }; width: number; height: number; focusId: string | null;
  neighbors: Map<string, Set<string>>; onSelect: (n: N | null) => void; flyTo: string | null;
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fg = useRef<any>(null);
  const spin = useRef(true);
  const bloomAdded = useRef(false); const dist = useRef(560);

  useEffect(() => {
    const g = fg.current; if (!g) return;
    if (!bloomAdded.current) {
      const bloom = new UnrealBloomPass(new THREE.Vector2(width, height), 0.85, 0.5, 0.2);
      g.postProcessingComposer().addPass(bloom); bloomAdded.current = true;
    }
    g.d3Force("charge")?.strength(-60);
    g.d3Force("link")?.distance((l: L) => (l.kind === "tag" ? 55 : 32)).strength((l: L) => (l.kind === "tag" ? 0.1 : 0.6));
    let angle = 0; let raf = 0;
    const tick = () => {
      if (spin.current && fg.current) { angle += 0.0014; const r = dist.current; fg.current.cameraPosition({ x: r * Math.sin(angle), z: r * Math.cos(angle) }); }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [width, height]);

  useEffect(() => {
    if (!flyTo) return;
    const n = graph.nodes.find((x) => x.id === flyTo); if (!n || n.x == null) return;
    spin.current = false;
    const d = 90, r = 1 + d / Math.hypot(n.x!, n.y!, n.z!);
    fg.current?.cameraPosition({ x: n.x! * r, y: n.y! * r, z: n.z! * r }, n, 1400);
  }, [flyTo, graph]);

  const lit = (id: string) => !focusId || id === focusId || !!neighbors.get(focusId)?.has(id);
  const isFocusLink = (l: L) => !!focusId && (sid(l.source) === focusId || sid(l.target) === focusId);

  return (
    <div onPointerDown={() => { spin.current = false; }} onWheel={() => { spin.current = false; }}>
      <ForceGraph3D ref={fg} graphData={graph} width={width} height={height} backgroundColor="#020306" showNavInfo={false}
        warmupTicks={80} cooldownTicks={200} d3VelocityDecay={0.3}
        nodeRelSize={2.6} nodeResolution={14} nodeOpacity={0.95}
        nodeVal={(n: object) => { const x = n as N; return x.kind === "tag" ? 0.6 : (x.kind === "reel" ? 1 : 4) + (x.deg || 0) * 0.3; }}
        nodeColor={(n: object) => { const x = n as N; return lit(x.id) ? COLORS[x.kind] || "#999" : "#1b2130"; }}
        nodeLabel={(n: object) => `<div style="padding:6px 10px;background:rgba(10,12,20,.9);border:1px solid rgba(148,163,200,.25);border-radius:8px;font:12px Inter,system-ui">${(n as N).name.replace(/</g, "&lt;")}</div>`}
        nodeThreeObjectExtend
        nodeThreeObject={(n: object) => {
          const x = n as N;
          if (x.kind !== "idea" && x.kind !== "summary" && x.kind !== "home") return undefined as unknown as THREE.Object3D;
          const t = new SpriteText(x.name.length > 30 ? clip(x.name, 28) + "…" : x.name, 3.2, "rgba(232,236,246,.85)");
          t.fontFace = "Inter, system-ui, sans-serif"; t.fontWeight = "600"; t.position.y = -8;
          return t;
        }}
        linkColor={(l: object) => (isFocusLink(l as L) ? "#8b9dff" : (l as L).kind === "tag" ? "#1e293b" : "#3b4a6b")}
        linkOpacity={0.35} linkWidth={(l: object) => (isFocusLink(l as L) ? 1.2 : 0)}
        linkDirectionalParticles={(l: object) => (isFocusLink(l as L) ? 3 : (l as L).kind === "tag" ? 0 : 1)}
        linkDirectionalParticleSpeed={0.004} linkDirectionalParticleWidth={(l: object) => (isFocusLink(l as L) ? 2.2 : 0.9)}
        linkDirectionalParticleColor={(l: object) => (isFocusLink(l as L) ? "#c4b5fd" : "#5eead4")}
        onNodeClick={(n: object) => onSelect(n as N)}
        onBackgroundClick={() => onSelect(null)} />
    </div>
  );
}
