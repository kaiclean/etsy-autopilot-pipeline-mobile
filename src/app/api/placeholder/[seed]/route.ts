import type { Niche } from "@/db/schema";

function rng(seed: number) {
  let a = seed || 1;
  return () => {
    a = (a * 1664525 + 1013904223) % 4294967296;
    return a / 4294967296;
  };
}

const esc = (s: string) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

function alpine(r: () => number, w: number, h: number) {
  const hue = 190 + Math.floor(r() * 50);
  const layers = [0.55, 0.65, 0.78].map((base, i) => {
    let d = `M0 ${h}`;
    const peaks = 4 + Math.floor(r() * 3);
    for (let p = 0; p <= peaks; p++) {
      const x = (p / peaks) * w;
      const y = h * (base - (p % 2 === 0 ? 0 : 0.12 + r() * 0.18) + i * 0.02);
      d += ` L${x.toFixed(0)} ${y.toFixed(0)}`;
    }
    d += ` L${w} ${h} Z`;
    return `<path d="${d}" fill="hsl(${hue + i * 8} ${28 - i * 6}% ${62 - i * 16}%)"/>`;
  });
  const sunX = w * (0.25 + r() * 0.5);
  return `<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hue - 170} 55% 88%)"/><stop offset="1" stop-color="hsl(${hue} 35% 82%)"/></linearGradient></defs>
<rect width="${w}" height="${h}" fill="url(#sky)"/><circle cx="${sunX}" cy="${h * 0.3}" r="${w * 0.1}" fill="hsl(${hue - 170} 80% 70%)" opacity="0.85"/>${layers.join("")}`;
}

function gothic(r: () => number, w: number, h: number) {
  const flowers = Array.from({ length: 7 }, () => {
    const cx = r() * w;
    const cy = h * 0.2 + r() * h * 0.7;
    const s = 30 + r() * 60;
    const hue = [330, 345, 285, 10][Math.floor(r() * 4)];
    const petals = Array.from({ length: 6 }, (_, i) => {
      const a = (i / 6) * Math.PI * 2;
      return `<ellipse cx="${cx + Math.cos(a) * s * 0.55}" cy="${cy + Math.sin(a) * s * 0.55}" rx="${s * 0.45}" ry="${s * 0.25}" transform="rotate(${(a * 180) / Math.PI} ${cx + Math.cos(a) * s * 0.55} ${cy + Math.sin(a) * s * 0.55})" fill="hsl(${hue} 55% ${28 + r() * 14}%)"/>`;
    }).join("");
    return `<path d="M${cx} ${cy} Q ${cx + 40} ${cy + 120} ${cx - 10} ${h}" stroke="hsl(140 25% 22%)" stroke-width="4" fill="none"/>${petals}<circle cx="${cx}" cy="${cy}" r="${s * 0.22}" fill="hsl(40 60% 55%)"/>`;
  }).join("");
  return `<rect width="${w}" height="${h}" fill="hsl(290 30% 9%)"/><rect x="24" y="24" width="${w - 48}" height="${h - 48}" fill="none" stroke="hsl(40 45% 45%)" stroke-width="2" opacity="0.5"/>${flowers}`;
}

function christmas(r: () => number, w: number, h: number) {
  const trees = Array.from({ length: 5 }, (_, i) => {
    const x = (i + 0.5) * (w / 5) + (r() - 0.5) * 30;
    const s = 70 + r() * 70;
    const base = h * 0.82;
    return `<path d="M${x} ${base - s * 1.6} L${x - s * 0.55} ${base} L${x + s * 0.55} ${base} Z" fill="hsl(${150 + r() * 20} 40% ${22 + r() * 10}%)"/><rect x="${x - 6}" y="${base}" width="12" height="18" fill="hsl(25 40% 25%)"/>`;
  }).join("");
  const snow = Array.from({ length: 70 }, () => `<circle cx="${r() * w}" cy="${r() * h}" r="${1 + r() * 3}" fill="white" opacity="${0.4 + r() * 0.6}"/>`).join("");
  return `<rect width="${w}" height="${h}" fill="hsl(355 45% 30%)"/><rect y="${h * 0.82}" width="${w}" height="${h * 0.18}" fill="hsl(30 30% 92%)"/>${trees}${snow}<circle cx="${w * 0.8}" cy="${h * 0.16}" r="${w * 0.06}" fill="hsl(45 90% 75%)"/>`;
}

function birthday(r: () => number, w: number, h: number, label: string) {
  const hue = Math.floor(r() * 360);
  const confetti = Array.from({ length: 60 }, () => {
    const x = r() * w;
    const y = r() * h;
    return `<rect x="${x}" y="${y}" width="10" height="5" rx="2" transform="rotate(${r() * 180} ${x} ${y})" fill="hsl(${(hue + r() * 140) % 360} 70% 70%)"/>`;
  }).join("");
  return `<rect width="${w}" height="${h}" fill="hsl(${hue} 60% 95%)"/>${confetti}<rect x="${w * 0.12}" y="${h * 0.22}" width="${w * 0.76}" height="${h * 0.56}" rx="24" fill="white" opacity="0.92"/>
<text x="${w / 2}" y="${h * 0.38}" text-anchor="middle" font-family="Georgia, serif" font-size="${w * 0.055}" fill="hsl(${hue} 40% 40%)" font-style="italic">You're invited</text>
<text x="${w / 2}" y="${h * 0.5}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="${w * 0.07}" fill="hsl(${hue} 50% 30%)">${esc(label.split(" ").slice(0, 3).join(" ").toUpperCase())}</text>
<text x="${w / 2}" y="${h * 0.62}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="${w * 0.035}" fill="hsl(${hue} 20% 45%)">Saturday · 2 PM · Editable template</text>`;
}

function stream(r: () => number, w: number, h: number) {
  const hue = 260 + Math.floor(r() * 60);
  const grid = Array.from({ length: 12 }, (_, i) => `<line x1="0" y1="${h * 0.55 + i * i * 4}" x2="${w}" y2="${h * 0.55 + i * i * 4}" stroke="hsl(${hue + 60} 100% 60%)" stroke-opacity="0.35"/>`).join("");
  const vgrid = Array.from({ length: 13 }, (_, i) => `<line x1="${w / 2}" y1="${h * 0.55}" x2="${(i / 12) * w * 2 - w / 2}" y2="${h}" stroke="hsl(${hue + 60} 100% 60%)" stroke-opacity="0.35"/>`).join("");
  return `<rect width="${w}" height="${h}" fill="hsl(${hue} 60% 8%)"/>${grid}${vgrid}
<rect x="${w * 0.08}" y="${h * 0.1}" width="${w * 0.55}" height="${h * 0.42}" rx="14" fill="none" stroke="hsl(${hue + 60} 100% 65%)" stroke-width="5"/>
<rect x="${w * 0.08}" y="${h * 0.1}" width="${w * 0.14}" height="${h * 0.07}" rx="6" fill="hsl(350 90% 55%)"/><text x="${w * 0.15}" y="${h * 0.155}" text-anchor="middle" font-family="Helvetica, Arial" font-weight="800" font-size="${h * 0.04}" fill="white">LIVE</text>
<rect x="${w * 0.68}" y="${h * 0.1}" width="${w * 0.24}" height="${h * 0.42}" rx="14" fill="hsl(${hue} 70% 18%)" stroke="hsl(${hue + 20} 100% 70%)" stroke-width="2"/>`;
}

export async function GET(req: Request, ctx: { params: Promise<{ seed: string }> }) {
  const { seed } = await ctx.params;
  const url = new URL(req.url);
  const niche = (url.searchParams.get("niche") ?? "alpine") as Niche;
  const label = url.searchParams.get("label") ?? "Design";
  const n = Number(seed) || 1;
  const r = rng(n);
  const wide = niche === "stream";
  const w = wide ? 960 : 800;
  const h = wide ? 540 : 1000;
  const body =
    niche === "gothic"
      ? gothic(r, w, h)
      : niche === "christmas"
        ? christmas(r, w, h)
        : niche === "birthday"
          ? birthday(r, w, h, label)
          : niche === "stream"
            ? stream(r, w, h)
            : alpine(r, w, h);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${body}
<g opacity="0.85"><rect x="${w - 130}" y="${h - 46}" width="114" height="30" rx="15" fill="black" fill-opacity="0.55"/><text x="${w - 73}" y="${h - 26}" text-anchor="middle" font-family="Helvetica, Arial" font-weight="700" font-size="13" fill="white" letter-spacing="2">MOCK ART</text></g></svg>`;
  return new Response(svg, {
    headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=31536000, immutable" },
  });
}
