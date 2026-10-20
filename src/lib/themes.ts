import { asc, eq, inArray } from "drizzle-orm";
import type { DB } from "@/db";
import { themes, type Niche, type Theme, type ThemeProduct, type ThemeStatus } from "@/db/schema";
import { NICHES, isNichePaused } from "@/lib/niches";
import { keywordHasUndeliverablePromise } from "@/lib/delivery";

export type ThemeSeed = Omit<Theme, "createdAt" | "updatedAt">;

/** Products the image pipeline can honestly deliver today (one PNG master, POD via existing presets). */
export const PIPELINE_PRODUCTS: ThemeProduct[] = ["wall-art", "poster", "pod-apparel", "pod-mug"];
export const ALL_PRODUCTS: ThemeProduct[] = [...PIPELINE_PRODUCTS, "planner", "template", "prompt-pack"];
export const THEME_STATUSES: ThemeStatus[] = ["proposed", "active", "paused", "retired"];
export const PRODUCT_LABEL: Record<ThemeProduct, string> = {
  "wall-art": "Digital wall art", poster: "Poster (POD)", "pod-apparel": "T-shirt / sweatshirt (POD)", "pod-mug": "Mug (POD)",
  planner: "Planner (PDF)", template: "Template", "prompt-pack": "Prompt pack (PDF)",
};
const FILE_BLOCKER = "Needs a real file built and checked by hand (the image pipeline only makes one PNG artwork). Keep as backlog until the file exists.";

/**
 * Starting themes for Designed by Kai. Sources: /workspace/GROWTH-BRAINSTORM.md (niche table, 2026-10),
 * the rival dossier (dark botanicals) and the Halloween viral batch (2026-09-28). Seed phrases are
 * starting guesses, not measured volume; research scores them like any other candidate.
 */
export const SEED_THEMES: ThemeSeed[] = [
  { id: "swiss-city-posters", label: "Swiss city travel posters", baseNiche: "alpine", status: "active",
    style: "vintage Swiss travel poster look, flat screen-print shading, lake and old-town rooftops, warm sun, limited palette, no text",
    seeds: ["zurich travel poster", "lucerne wall art", "bern old town print", "interlaken poster", "lugano lake print"],
    products: ["wall-art", "poster"], peakMonths: [], blocker: null, notes: "Growth brainstorm A6: tourists and expats search city names.", source: "seed:growth-brainstorm" },
  { id: "alpine-botanicals", label: "Alpine wildflower botanicals", baseNiche: "alpine", status: "active",
    style: "vintage botanical engraving of alpine wildflowers, edelweiss, gentian and alpenrose on warm paper tone, fine hatching, no text",
    seeds: ["edelweiss botanical print", "alpine wildflower art", "vintage botanical poster", "swiss wildflower print", "gentian flower art"],
    products: ["wall-art", "poster"], peakMonths: [], blocker: null, notes: "Botanicals that stay on-brand with the alpine shop.", source: "seed:growth-brainstorm" },
  { id: "dark-botanicals", label: "Dark moody botanicals", baseNiche: "gothic", status: "active",
    style: "moody dark botanical still life, deep plum and forest green, candlelit chiaroscuro, vintage oil texture, no text",
    seeds: ["dark botanical print", "moody floral wall art", "dark academia flower", "gothic botanical art"],
    products: ["wall-art", "poster", "pod-apparel"], peakMonths: [8, 9, 10], blocker: null, notes: "Rival dossier: dark florals sell Aug-Nov.", source: "seed:rival-dossier" },
  { id: "vintage-halloween", label: "Vintage Halloween", baseNiche: "gothic", status: "active",
    style: "vintage 1920s Halloween illustration, black cats, moon and pumpkins, aged paper, muted orange and black, no text",
    seeds: ["vintage halloween print", "black cat halloween art", "witchy wall art", "pumpkin moon poster"],
    products: ["wall-art", "poster", "pod-apparel"], peakMonths: [8, 9], blocker: null, notes: "From the Halloween viral batch (2026-09-28). Late for 2026; keep for next season.", source: "seed:viral-scout" },
  { id: "alpine-christmas", label: "Alpine Christmas", baseNiche: "christmas", status: "active",
    style: "cozy alpine Christmas village at dusk, snow-covered chalets, warm windows, hand-drawn gouache texture, no text",
    seeds: ["alpine christmas print", "swiss christmas art", "chalet winter print", "snowy village poster", "christmas mountain mug"],
    products: ["wall-art", "poster", "pod-mug", "pod-apparel"], peakMonths: [9, 10, 11], blocker: null, notes: "Growth brainstorm A2: the Sep-Nov window is now.", source: "seed:growth-brainstorm" },
  { id: "nordic-quiet", label: "Quiet Nordic neutrals", baseNiche: "alpine", status: "active",
    style: "quiet minimalist Nordic landscape, beige, sand and stone, soft gradients, large negative space, no text",
    seeds: ["beige mountain print", "neutral landscape art", "minimalist nordic print", "sand tone wall art"],
    products: ["wall-art", "poster"], peakMonths: [], blocker: null, notes: "Growth brainstorm A7: overlaps the alpine palette.", source: "seed:growth-brainstorm" },
  { id: "ai-printables", label: "AI-assisted printable art", baseNiche: "alpine", status: "active",
    style: null,
    seeds: ["printable mountain art", "digital download poster", "instant download wall art"],
    products: ["wall-art"], peakMonths: [], blocker: null, notes: "AI-assisted digital downloads; the listing always carries the AI disclosure.", source: "seed:kai-goal" },
  { id: "swiss-planners", label: "Swiss / alpine planners", baseNiche: "alpine", status: "proposed",
    style: null, seeds: ["swiss budget planner", "chf budget planner", "alpine habit tracker"],
    products: ["planner"], peakMonths: [11, 0], blocker: FILE_BLOCKER, notes: "Matches Brain ideas (Swiss Budget Planner CHF). Needs a real PDF.", source: "seed:kai-goal" },
  { id: "retro-pixel", label: "Retro pixel art", baseNiche: "gothic", status: "proposed",
    style: "original retro 16-bit pixel art scene, limited palette, crisp pixels, no characters from existing games, no text",
    seeds: ["retro pixel art poster", "pixel art gamer shirt", "8 bit mountain art"],
    products: ["poster", "pod-apparel"], peakMonths: [], blocker: null, notes: "From the Brain idea Retro Gaming Hacker POD. Trademark-sensitive: original art only.", source: "seed:brain" },
];

let seeded = false;
/** Inserts missing seed themes. Never overwrites Kai's edits. */
export async function ensureThemeSeeds(db: DB) {
  if (seeded) return;
  for (const t of SEED_THEMES) await db.insert(themes).values(t).onConflictDoNothing({ target: themes.id });
  seeded = true;
}
export function resetThemeSeedCache() { seeded = false; }

export async function listThemes(db: DB): Promise<Theme[]> {
  await ensureThemeSeeds(db);
  return db.select().from(themes).orderBy(asc(themes.status), asc(themes.label));
}

/** A theme can feed research only when it is active, unblocked, rides an unpaused niche and makes a pipeline product. */
export function themeRunnable(t: Pick<Theme, "status" | "blocker" | "baseNiche" | "products">) {
  return t.status === "active" && !t.blocker && !isNichePaused(t.baseNiche) && t.products.some((p) => PIPELINE_PRODUCTS.includes(p));
}

export async function runnableThemes(db: DB) {
  return (await listThemes(db)).filter(themeRunnable);
}

/** Research candidates from active themes. Same shape as other keyword sources. */
export async function themeCandidates(db: DB) {
  return (await runnableThemes(db)).flatMap((t) => t.seeds
    .map((phrase) => phrase.trim().toLowerCase())
    .filter((phrase) => phrase && !keywordHasUndeliverablePromise(phrase))
    .map((phrase) => ({ phrase, niche: t.baseNiche, source: `theme:${t.id}`, demand: 0.6, competition: 0.5, themeId: t.id })));
}

export async function themeStyles(db: DB, ids: string[]) {
  if (!ids.length) return new Map<string, string>();
  const rows = await db.select({ id: themes.id, style: themes.style }).from(themes).where(inArray(themes.id, ids));
  return new Map(rows.flatMap((r) => (r.style ? [[r.id, r.style] as const] : [])));
}

export const slugify = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);

export type ThemeInput = {
  id?: string; label: string; baseNiche: string; status: string; style?: string | null; seeds: string[];
  products: string[]; peakMonths?: number[]; blocker?: string | null; notes?: string | null; source?: string;
};

/** Validates editor input; returns a clean row or an error message. */
export function cleanThemeInput(input: ThemeInput): { ok: true; row: ThemeSeed } | { ok: false; error: string } {
  const label = input.label.trim().slice(0, 80);
  if (label.length < 3) return { ok: false, error: "Give the theme a name (3+ characters)." };
  if (!(input.baseNiche in NICHES)) return { ok: false, error: "Pick a production niche." };
  if (!THEME_STATUSES.includes(input.status as ThemeStatus)) return { ok: false, error: "Unknown status." };
  const products = [...new Set(input.products)].filter((p): p is ThemeProduct => ALL_PRODUCTS.includes(p as ThemeProduct));
  if (!products.length) return { ok: false, error: "Pick at least one product type." };
  const seeds = [...new Set(input.seeds.map((s) => s.toLowerCase().replace(/[^a-z0-9äöüéèàç' -]/gi, " ").replace(/\s+/g, " ").trim()))]
    .filter((s) => s.length >= 4 && s.length <= 60 && s.split(" ").length >= 2).slice(0, 20);
  const undeliverable = seeds.filter((s) => keywordHasUndeliverablePromise(s));
  if (undeliverable.length) return { ok: false, error: `These phrases promise files the pipeline cannot deliver: ${undeliverable.join(", ")}.` };
  const id = input.id?.trim() || slugify(label);
  if (!/^[a-z0-9-]{3,48}$/.test(id)) return { ok: false, error: "Theme id must be 3-48 lowercase letters, digits or dashes." };
  const pipelineCapable = products.some((p) => PIPELINE_PRODUCTS.includes(p));
  const blocker = input.blocker?.trim() || (pipelineCapable ? null : FILE_BLOCKER);
  return { ok: true, row: {
    id, label, baseNiche: input.baseNiche as Niche, status: input.status as ThemeStatus, style: input.style?.trim().slice(0, 400) || null,
    seeds, products, peakMonths: (input.peakMonths ?? []).filter((m) => Number.isInteger(m) && m >= 0 && m <= 11),
    blocker: blocker ? blocker.slice(0, 400) : null, notes: input.notes?.trim().slice(0, 1000) || null, source: input.source ?? "manual",
  } };
}

export async function saveTheme(db: DB, row: ThemeSeed) {
  await ensureThemeSeeds(db);
  await db.insert(themes).values(row).onConflictDoUpdate({ target: themes.id, set: { ...row, updatedAt: new Date() } });
}

export async function setThemeStatus(db: DB, id: string, status: ThemeStatus) {
  await db.update(themes).set({ status, updatedAt: new Date() }).where(eq(themes.id, id));
}
