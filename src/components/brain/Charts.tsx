// Lightweight, server-rendered SVG charts with CSS-driven entrance animations.
type Pt = { label: string; value: number };
const fmt = (n: number) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(Math.round(n * 10) / 10));

export function AreaChart({ data, color = "#8b9dff", height = 180 }: { data: Pt[]; color?: string; height?: number }) {
  if (!data.length) return <div className="empty xs">No data yet</div>;
  const W = 900, H = height, P = 24, max = Math.max(...data.map((d) => d.value), 1);
  const x = (i: number) => P + (i * (W - 2 * P)) / Math.max(data.length - 1, 1);
  const y = (v: number) => H - P - (v / max) * (H - 2 * P);
  const line = data.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(d.value).toFixed(1)}`).join(" ");
  const id = "g" + color.replace(/\W/g, "");
  const step = Math.ceil(data.length / 8);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img">
      <defs><linearGradient id={id} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor={color} stopOpacity=".45" /><stop offset="1" stopColor={color} stopOpacity="0" /></linearGradient></defs>
      {[0.25, 0.5, 0.75, 1].map((f) => <line key={f} x1={P} x2={W - P} y1={y(max * f)} y2={y(max * f)} className="gridline" />)}
      <path d={`${line} L${x(data.length - 1)},${H - P} L${x(0)},${H - P} Z`} fill={`url(#${id})`} className="area-fill" />
      <path d={line} fill="none" stroke={color} strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" className="draw" pathLength={1} />
      {data.map((d, i) => <g key={i}><circle cx={x(i)} cy={y(d.value)} r="3" fill={color} className="pop" style={{ animationDelay: `${300 + i * 25}ms` }}><title>{`${d.label}: ${d.value}`}</title></circle>
        {i % step === 0 && <text x={x(i)} y={H - 6} className="axis" textAnchor="middle">{d.label}</text>}</g>)}
      <text x={P} y={y(max) - 6} className="axis">{fmt(max)}</text>
    </svg>
  );
}

export function BarList({ data, color = "#2dd4bf", hrefFor, max: maxIn }: { data: Pt[]; color?: string; hrefFor?: (l: string) => string; max?: number }) {
  if (!data.length) return <div className="empty xs">No data yet</div>;
  const max = maxIn || Math.max(...data.map((d) => d.value), 1);
  return (
    <div className="barlist">
      {data.map((d, i) => {
        const inner = <><div className="bl-label">{d.label}</div><div className="bl-track"><div className="bl-bar" style={{ width: `${(d.value / max) * 100}%`, background: `linear-gradient(90deg, ${color}55, ${color})`, animationDelay: `${i * 40}ms` }} /></div><div className="bl-val">{fmt(d.value)}</div></>;
        return hrefFor ? <a key={d.label} href={hrefFor(d.label)} className="bl-row">{inner}</a> : <div key={d.label} className="bl-row">{inner}</div>;
      })}
    </div>
  );
}

export function Donut({ data, colors, size = 170 }: { data: Pt[]; colors: string[]; size?: number }) {
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  const r = 60, c = 2 * Math.PI * r;
  return (
    <div className="donut-wrap">
      <svg viewBox="0 0 160 160" width={size} height={size} className="donut">
        <circle cx="80" cy="80" r={r} fill="none" stroke="rgba(255,255,255,.05)" strokeWidth="18" />
        {data.map((d, i) => { const len = (d.value / total) * c; const off = data.slice(0, i).reduce((s2, x) => s2 + (x.value / total) * c, 0); return <circle key={d.label} cx="80" cy="80" r={r} fill="none" stroke={colors[i % colors.length]} strokeWidth="18" strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-off} transform="rotate(-90 80 80)" className="donut-seg" style={{ animationDelay: `${i * 90}ms` }}><title>{`${d.label}: ${d.value}`}</title></circle>; })}
        <text x="80" y="78" textAnchor="middle" className="donut-total">{total}</text><text x="80" y="96" textAnchor="middle" className="axis">total</text>
      </svg>
      <div className="legend-list">{data.map((d, i) => <div key={d.label} className="row xs"><span className="dot" style={{ background: colors[i % colors.length] }} />{d.label}<span className="faint" style={{ marginLeft: "auto" }}>{d.value} · {Math.round((d.value / total) * 100)}%</span></div>)}</div>
    </div>
  );
}

export function Matrix({ items, href }: { items: { label: string; id: string; x: number; y: number; r: number }[]; href: (id: string) => string }) {
  // x: effort 0..2 (S,M,L), y: potential 0..2 (low..high)
  const W = 520, H = 300, P = 44;
  const X = (v: number) => P + (v + 0.5) * ((W - P - 12) / 3), Y = (v: number) => H - P - (v + 0.5) * ((H - P - 12) / 3);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart">
      <rect x={P} y={12} width={(W - P - 12) / 3} height={(H - P - 12) / 3} className="sweet" rx="10" />
      <text x={P + 8} y={28} className="axis" style={{ fill: "#a7f3d0" }}>quick wins</text>
      {[0, 1, 2].map((i) => <g key={i}><text x={X(i)} y={H - 18} textAnchor="middle" className="axis">{["S", "M", "L"][i]} effort</text><text x={P - 8} y={Y(i) + 4} textAnchor="end" className="axis">{["low", "med", "high"][i]}</text></g>)}
      {items.map((it, i) => (
        <a key={it.id} href={href(it.id)}>
          <circle cx={X(it.x)} cy={Y(it.y)} r={7 + it.r * 2.2} className="bubble pop" style={{ animationDelay: `${i * 50}ms` }}><title>{it.label}</title></circle>
        </a>
      ))}
    </svg>
  );
}
