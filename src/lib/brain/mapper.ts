import type { Niche, Theme, ThemeProduct } from "@/db/schema";
import { PIPELINE_PRODUCTS, PRODUCT_LABEL, themeRunnable } from "@/lib/themes";
import { keywordHasUndeliverablePromise } from "@/lib/delivery";
import type { Note } from "./vault";
import { sectionOf } from "./vault";

export type IdeaKind = "product" | "software" | "content";
export type Mapping = {
  kind: IdeaKind;
  product: ThemeProduct | null;
  productLabel: string | null;
  theme: { id: string; label: string; niche: Niche; runnable: boolean } | null;
  phrase: string | null;
  /** True only when the image pipeline can honestly make this product for a runnable theme. */
  pipelineReady: boolean;
  reason: string;
  matched: string[];
  derivative: { title: string; product: ThemeProduct; phrase: string; note: string } | null;
};

const STOP = new Set("the and for with from your you that this into over under kit set ch swiss chf etsy digital download printable print template templates planner pack collection pod a an of to in on or".split(" "));
const words = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9\s-]/g, " ").split(/[\s-]+/).filter((w) => w.length > 2 && !STOP.has(w));

export function ideaKind(n: Pick<Note, "data">): IdeaKind {
  const t = String(n.data.type ?? "").toLowerCase();
  if (t.includes("software") || t.includes("feature") || t.includes("app")) return "software";
  if (t.includes("content")) return "content";
  return "product";
}

/** What an Etsy product idea actually is. Art formats are pipeline-ready; files like planners need hand-built deliverables. */
export function productTypeOf(n: Pick<Note, "title" | "data">): ThemeProduct {
  const t = `${n.title} ${String(n.data.type ?? "")}`.toLowerCase();
  if (/\b(planner|tracker|journal|budget)\b/.test(t)) return "planner";
  if (/\b(template|book|card|letter|kit|lut|preset|invitation|invite)s?\b/.test(t)) return "template";
  if (/\bprompts?\b/.test(t)) return "prompt-pack";
  if (/\b(mug|cup)s?\b/.test(t)) return "pod-mug";
  if (/\b(pod|shirt|tee|hoodie|sweatshirt|apparel)\b/.test(t)) return "pod-apparel";
  if (/\bposter\b/.test(t)) return "poster";
  return "wall-art";
}

function themeVocab(t: Theme) {
  return new Set([...words(t.label), ...t.seeds.flatMap(words), ...words(t.style ?? "").slice(0, 30)]);
}

/** Best theme by shared vocabulary; needs 2+ shared words, title hits weigh double. */
export function bestTheme(n: Note, themes: Theme[]) {
  const text = new Set(words([n.title, n.tags.join(" "), sectionOf(n.body, "Etsy fit"), sectionOf(n.body, "Concept")].join(" ")));
  const title = words(n.title);
  let best: { theme: Theme; score: number; matched: string[] } | null = null;
  for (const t of themes.filter((x) => x.status !== "retired")) {
    const v = themeVocab(t);
    const matched = [...text].filter((w) => v.has(w));
    const score = matched.length + title.filter((w) => v.has(w)).length * 2 + (themeRunnable(t) ? 0.5 : 0);
    if (matched.length >= 2 && (!best || score > best.score)) best = { theme: t, score, matched };
  }
  return best;
}

const NOUN: Record<ThemeProduct, string> = {
  "wall-art": "wall art", poster: "poster", "pod-apparel": "shirt", "pod-mug": "mug", planner: "planner", template: "template", "prompt-pack": "prompt guide",
};

/** Buyer phrase: up to 4 content words from the title plus the product noun, 2+ words, no undeliverable promises. */
export function proposePhrase(title: string, product: ThemeProduct) {
  const noun = NOUN[product];
  const base = words(title).filter((w) => !noun.split(" ").includes(w)).slice(0, 4);
  let phrase = [...base, noun].join(" ").trim();
  if (keywordHasUndeliverablePromise(phrase) && PIPELINE_PRODUCTS.includes(product)) phrase = [...base, "art"].join(" ");
  return phrase.slice(0, 60);
}

/**
 * Honest Etsy derivatives for software/content ideas. Only where the idea already holds
 * know-how a buyer could use as a file; otherwise null. All need a hand-built file.
 */
function derivativeFor(n: Note): Mapping["derivative"] {
  const t = `${n.title} ${sectionOf(n.body, "Concept")}`.toLowerCase();
  const note = "Needs a real PDF/Canva file made and opened by Kai before any listing (etsy-produce manifest).";
  if (/\bseo\b|keyword/.test(t)) return { title: "Etsy SEO checklist and listing planner (PDF)", product: "planner", phrase: "etsy seo checklist", note };
  if (/content|cheat sheet|stack|marketing|social|dm|funnel/.test(t)) return { title: "Small-shop content planner (PDF)", product: "planner", phrase: "social media content planner", note };
  if (/\bagent|\bai\b|prompt|automation/.test(t)) return { title: "AI prompt guide for small online shops (PDF)", product: "prompt-pack", phrase: "ai prompt guide", note };
  if (/storefront|shop\b|website/.test(t)) return { title: "Shop launch checklist (PDF)", product: "planner", phrase: "online shop checklist", note };
  return null;
}

export function mapIdea(n: Note, themes: Theme[]): Mapping {
  const kind = ideaKind(n);
  if (kind !== "product") {
    const d = derivativeFor(n);
    return { kind, product: null, productLabel: null, theme: null, phrase: null, pipelineReady: false, matched: [],
      reason: kind === "software" ? "Software feature, not an Etsy product." + (d ? " A file derivative is possible." : " No honest Etsy derivative.") : "Content idea." + (d ? " A file derivative is possible." : ""),
      derivative: d };
  }
  const product = productTypeOf(n);
  const hit = bestTheme(n, themes);
  const theme = hit ? { id: hit.theme.id, label: hit.theme.label, niche: hit.theme.baseNiche, runnable: themeRunnable(hit.theme) } : null;
  const artProduct = PIPELINE_PRODUCTS.includes(product);
  const pipelineReady = Boolean(theme?.runnable && artProduct);
  const reason = !artProduct ? `${PRODUCT_LABEL[product]} needs a hand-built file; the pipeline only makes artwork.`
    : !theme ? "No theme matches yet. Add or activate a theme to send it to the pipeline."
    : !theme.runnable ? `Theme “${theme.label}” is not active yet.`
    : `Fits “${theme.label}”.`;
  return { kind, product, productLabel: PRODUCT_LABEL[product], theme, phrase: proposePhrase(n.title, product), pipelineReady, reason, matched: hit?.matched ?? [], derivative: null };
}
