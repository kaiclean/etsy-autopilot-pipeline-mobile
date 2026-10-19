"use client";
import { useEffect, useRef, useState } from "react";
export default function CountUp({ to, ms = 900 }: { to: number; ms?: number }) {
  const [v, setV] = useState(to); const started = useRef(false);
  useEffect(() => {
    if (started.current || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return; started.current = true;
    const t0 = performance.now(); let raf = 0;
    const step = (t: number) => { const p = Math.min((t - t0) / ms, 1); setV(Math.round(to * (1 - Math.pow(1 - p, 3)))); if (p < 1) raf = requestAnimationFrame(step); };
    setV(0); raf = requestAnimationFrame(step); return () => cancelAnimationFrame(raf);
  }, [to, ms]);
  return <span style={{ fontVariantNumeric: "tabular-nums" }}>{v}</span>;
}
