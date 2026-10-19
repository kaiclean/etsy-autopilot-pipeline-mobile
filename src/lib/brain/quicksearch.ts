export type QDoc = { id: string; kind: string; title: string; handle: string; date: string; thumb: string | null; summary: string; text: string };
export const terms = (q: string) => q.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
/** Rank docs: every term must match title/handle or body; title hits weigh most. */
export function rank(docs: QDoc[], q: string, limit = 8): QDoc[] {
  const ts = terms(q); if (!ts.length) return [];
  const out: { d: QDoc; s: number }[] = [];
  for (const d of docs) {
    const t = (d.title + " " + d.handle).toLowerCase(), x = d.text.toLowerCase(); let s = 0, ok = true;
    for (const w of ts) { const a = t.includes(w), b = x.includes(w); if (!a && !b) { ok = false; break; } s += (a ? 10 : 0) + (b ? 1 : 0) + (t.startsWith(w) ? 5 : 0); }
    if (ok) out.push({ d, s: s + (d.kind === "idea" ? 2 : 0) });
  }
  return out.sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.d);
}
export const noteHref = (id: string) => "/brain/note/" + id.split("/").map(encodeURIComponent).join("/");
export const searchHref = (q: string) => "/brain/search?q=" + encodeURIComponent(q.trim());
/** Truncate by code points so emoji surrogate pairs are never split (a split pair breaks SSR hydration). */
export const clip = (s: string, n: number) => { const a = Array.from(s); return a.length > n ? a.slice(0, n).join("") : s; };
