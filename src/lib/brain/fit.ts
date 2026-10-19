import { activeNiches, type NicheConfig } from "@/lib/niches";
import type { Niche } from "@/db/schema";
import type { Note } from "./vault";
import { sectionOf } from "./vault";

/** Words that say nothing about a theme. */
const STOP = new Set("the and for with from your you that this into over under kit pack set template templates planner digital download printable print etsy ch swiss and or of a an to in on".split(" "));
const words = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9\s-]/g, " ").split(/[\s-]+/).filter((w) => w.length > 2 && !STOP.has(w));

export type ThemeFit = { niche: Niche; label: string; score: number; matched: string[]; phrase: string };

/** Only product ideas can become pipeline keywords; software/content ideas stay as backlog. */
export function isProductIdea(n: Note) {
  const t = String(n.data.type ?? "").toLowerCase();
  return t === "digital product" || t === "pod" || t === "product";
}

function nicheVocab(n: NicheConfig) {
  return new Set([...words(n.label), ...words(n.short), ...n.seeds.flatMap((s) => words(s.phrase))]);
}

/**
 * Best active niche for an idea, or null when nothing fits.
 * A fit needs at least two distinct theme words in the idea's title, tags or Etsy-fit text.
 */
export function themeFit(n: Note, niches: NicheConfig[] = activeNiches()): ThemeFit | null {
  if (!isProductIdea(n)) return null;
  const text = new Set(words([n.title, n.tags.join(" "), sectionOf(n.body, "Etsy fit"), sectionOf(n.body, "Concept")].join(" ")));
  let best: ThemeFit | null = null;
  for (const niche of niches) {
    const vocab = nicheVocab(niche);
    const matched = [...text].filter((w) => vocab.has(w));
    const titleHits = words(n.title).filter((w) => vocab.has(w)).length;
    const score = matched.length + titleHits * 2;
    if (matched.length >= 2 && (!best || score > best.score)) best = { niche: niche.id, label: niche.label, score, matched, phrase: proposePhrase(n, niche) };
  }
  return best;
}

/** A starting search phrase; Kai edits and confirms it in the approve form. */
export function proposePhrase(n: Note, niche: NicheConfig) {
  const base = words(n.title).slice(0, 4).join(" ");
  const theme = words(niche.short)[0];
  return (base.includes(theme ?? "") || !theme ? base : `${theme} ${base}`).trim().slice(0, 80);
}

/** Etsy-style phrase hygiene: lowercase, letters/digits/spaces, 2-80 chars, 2+ words. */
export function cleanPhrase(raw: string): string | null {
  const p = raw.toLowerCase().replace(/[^a-z0-9äöüéèàç\s-]/gi, " ").replace(/\s+/g, " ").trim();
  if (p.length < 4 || p.length > 80 || p.split(" ").length < 2) return null;
  return p;
}
