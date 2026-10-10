import type { Niche, ProductType } from "@/db/schema";
import type { PodPreset } from "./fees";

export type NicheConfig = {
  id: Niche;
  label: string;
  short: string;
  color: string;
  /** Month indexes (0-11) where demand peaks. Empty = evergreen. */
  peakMonths: number[];
  productMix: { type: ProductType; pod?: PodPreset; weight: number }[];
  /** Soft CHF guard [min, max]. Pricing may sit inside the band; POD is not pinned to the max. */
  priceBand: { digital: [number, number]; pod: [number, number] };
  style: string;
  seeds: { phrase: string; demand: number; competition: number }[];
  /**
   * Set when the niche's honest product does not exist yet.
   * Research, design and listing skip it. Copy must still not promise the missing files.
   */
  pausedReason?: string;
};

/**
 * Seed keywords come from the business plan §3 (eRank Aug/Sep 2026 public reports).
 * demand/competition are 0-1 heuristics from the reported rank/CTR, not measured search volume.
 */
export const NICHES: Record<Niche, NicheConfig> = {
  alpine: {
    id: "alpine",
    label: "Alpine / Swiss wall art",
    short: "Alpine",
    color: "var(--chart-1)",
    peakMonths: [],
    productMix: [
      { type: "digital", weight: 0.6 },
      { type: "pod", pod: "posterA3", weight: 0.4 },
    ],
    priceBand: { digital: [5.9, 14.9], pod: [24.9, 39.9] },
    style: "bestselling Etsy alpine wall art, layered Swiss mountains and a quiet lake, muted sage and stone, soft grain, print-ready, no text",
    seeds: [
      { phrase: "swiss alps wall art", demand: 0.72, competition: 0.45 },
      { phrase: "matterhorn print", demand: 0.64, competition: 0.38 },
      { phrase: "minimalist mountain poster", demand: 0.81, competition: 0.7 },
      { phrase: "alpine lake printable", demand: 0.55, competition: 0.3 },
      { phrase: "swiss travel poster", demand: 0.68, competition: 0.52 },
      { phrase: "mountain gallery wall art", demand: 0.74, competition: 0.61 },
    ],
  },
  gothic: {
    id: "gothic",
    label: "Gothic floral autumn",
    short: "Gothic",
    color: "var(--chart-2)",
    peakMonths: [8, 9],
    productMix: [
      { type: "pod", pod: "tshirt", weight: 0.5 },
      { type: "pod", pod: "posterA3", weight: 0.3 },
      { type: "digital", weight: 0.2 },
    ],
    priceBand: { digital: [3.9, 8.9], pod: [24.9, 44.9] },
    style: "bestselling Etsy dark gothic florals, plum and burgundy, vintage botanical engraving, candlelit autumn, no text",
    seeds: [
      { phrase: "gothic floral shirt", demand: 0.7, competition: 0.55 },
      { phrase: "dark academia print", demand: 0.66, competition: 0.6 },
      { phrase: "halloween floral png", demand: 0.78, competition: 0.5 },
      { phrase: "moody botanical art", demand: 0.58, competition: 0.42 },
      { phrase: "witchy autumn decor", demand: 0.63, competition: 0.48 },
    ],
  },
  christmas: {
    id: "christmas",
    label: "Christmas / cozy gifts",
    short: "Christmas",
    color: "var(--chart-3)",
    peakMonths: [9, 10, 11],
    productMix: [
      { type: "pod", pod: "mug", weight: 0.4 },
      { type: "pod", pod: "posterA3", weight: 0.3 },
      { type: "pod", pod: "sweatshirt", weight: 0.3 },
    ],
    priceBand: { digital: [3.9, 9.9], pod: [19.9, 49.9] },
    style: "bestselling Etsy cozy Christmas illustration, candlelight, pine green and deep red, snowy cabin, hygge, no text",
    seeds: [
      { phrase: "cozy christmas mug", demand: 0.76, competition: 0.62 },
      { phrase: "alpine christmas print", demand: 0.6, competition: 0.28 },
      { phrase: "cozy winter gift", demand: 0.85, competition: 0.8 },
      { phrase: "christmas cabin print", demand: 0.7, competition: 0.5 },
      { phrase: "hygge winter poster", demand: 0.57, competition: 0.33 },
    ],
  },
  birthday: {
    id: "birthday",
    label: "Birthday party art",
    short: "Birthday",
    color: "var(--chart-4)",
    peakMonths: [],
    productMix: [{ type: "digital", weight: 1 }],
    priceBand: { digital: [4.9, 9.9], pod: [0, 0] },
    style: "bestselling Etsy pastel birthday illustration, soft paper texture, playful still life, opaque background, no lettering",
    pausedReason:
      "Paused until a real invitation file exists. The pipeline only makes one opaque PNG, so it cannot sell an editable invite, template, or evite.",
    seeds: [
      { phrase: "one silly goose birthday", demand: 0.88, competition: 0.25 },
      { phrase: "birthday party art", demand: 0.8, competition: 0.72 },
      { phrase: "wildflower first birthday", demand: 0.62, competition: 0.4 },
      { phrase: "two cool birthday art", demand: 0.59, competition: 0.35 },
    ],
  },
  stream: {
    id: "stream",
    label: "Stream art",
    short: "Stream",
    color: "var(--chart-5)",
    peakMonths: [],
    productMix: [{ type: "digital", weight: 1 }],
    priceBand: { digital: [4.9, 19.9], pod: [0, 0] },
    style: "bestselling Etsy neon scene, saturated purple and cyan, solid opaque background, no text, no frames",
    pausedReason:
      "Paused until a real stream kit exists. The pipeline only makes one opaque PNG, so it cannot sell emotes, panels, alerts, webcam frames, or animated overlays.",
    seeds: [
      { phrase: "neon stream art", demand: 0.74, competition: 0.58 },
      { phrase: "purple cyan artwork", demand: 0.8, competition: 0.55 },
      { phrase: "cute neon graphic", demand: 0.7, competition: 0.62 },
      { phrase: "pastel neon art", demand: 0.61, competition: 0.4 },
    ],
  },
};

export const NICHE_LIST = Object.values(NICHES);

export function isNichePaused(id: Niche) {
  return Boolean(NICHES[id].pausedReason);
}

/** Niches the pipeline may research, design and list. Birthday and stream stay paused. */
export function activeNiches() {
  return NICHE_LIST.filter((n) => !n.pausedReason);
}

export function seasonality(niche: Niche, date = new Date()) {
  const peaks = NICHES[niche].peakMonths;
  if (peaks.length === 0) return 0.6;
  const m = date.getMonth();
  const dist = Math.min(...peaks.map((p) => Math.min(Math.abs(p - m), 12 - Math.abs(p - m))));
  return Math.max(0.1, 1 - dist * 0.25);
}

/**
 * Map an Etsy search volume onto 0–1.
 * 10 → 0.2, 100 → 0.4, 1_000 → 0.6, 10_000 → 0.8, 100_000 → 1.
 */
export function normalizeEtsyVolume(volume: number) {
  if (!Number.isFinite(volume) || volume <= 0) return 0;
  const score = Math.log10(volume) / 5;
  return Math.round(Math.min(1, Math.max(0, score)) * 100) / 100;
}

export function scoreKeyword(k: {
  demand: number;
  competition: number;
  seasonality: number;
  trend?: number | null;
  /** Measured Etsy search volume. When set, it replaces seed demand and is not blended with Google Trends. */
  searchVolume?: number | null;
  /** Real listing outcomes, used only when recent analytics and a meaningful view sample exist. */
  performance?: { views: number; favorites: number; sales: number };
}) {
  const measured = k.searchVolume != null ? normalizeEtsyVolume(k.searchVolume) : null;
  const demand = measured != null ? measured : k.trend != null ? k.demand * 0.6 + k.trend * 0.4 : k.demand;
  const base = 0.45 * demand + 0.3 * (1 - k.competition) + 0.25 * k.seasonality;
  const performance = k.performance;
  let lift = 0;
  if (performance && performance.views >= 20) {
    const confidence = Math.min(1, performance.views / 100);
    const conversionRate = performance.sales / performance.views;
    const favoriteRate = performance.favorites / performance.views;
    const conversionLift = Math.max(-0.08, Math.min(0.08, (conversionRate - 0.02) * 2));
    lift = (conversionLift + Math.min(0.02, favoriteRate * 0.1)) * confidence;
  }
  return Math.round(Math.max(0, Math.min(1, base + lift)) * 100) / 100;
}
