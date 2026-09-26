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
  priceBand: { digital: [number, number]; pod: [number, number] };
  style: string;
  seeds: { phrase: string; demand: number; competition: number }[];
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
    style: "minimalist Swiss alpine landscape, flat vector shapes, muted earthy palette, soft grain, gallery wall art",
    seeds: [
      { phrase: "swiss alps wall art", demand: 0.72, competition: 0.45 },
      { phrase: "matterhorn print", demand: 0.64, competition: 0.38 },
      { phrase: "minimalist mountain poster", demand: 0.81, competition: 0.7 },
      { phrase: "alpine lake printable", demand: 0.55, competition: 0.3 },
      { phrase: "swiss travel poster", demand: 0.68, competition: 0.52 },
      { phrase: "mountain gallery wall set", demand: 0.74, competition: 0.61 },
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
    style: "dark gothic florals, plum and burgundy palette, moody vintage botanical illustration, autumn",
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
    style: "cozy hand-drawn christmas illustration, warm red and pine green, hygge, candlelight, snow",
    seeds: [
      { phrase: "cozy christmas mug", demand: 0.76, competition: 0.62 },
      { phrase: "alpine christmas print", demand: 0.6, competition: 0.28 },
      { phrase: "personalized gift for her", demand: 0.85, competition: 0.8 },
      { phrase: "christmas ornament design", demand: 0.7, competition: 0.5 },
      { phrase: "hygge winter poster", demand: 0.57, competition: 0.33 },
    ],
  },
  birthday: {
    id: "birthday",
    label: "Editable birthday invitations",
    short: "Invites",
    color: "var(--chart-4)",
    peakMonths: [],
    productMix: [{ type: "digital", weight: 1 }],
    priceBand: { digital: [4.9, 9.9], pod: [0, 0] },
    style: "playful editable birthday invitation template, pastel palette, whimsical hand lettering",
    seeds: [
      { phrase: "one silly goose birthday", demand: 0.88, competition: 0.25 },
      { phrase: "editable birthday invite", demand: 0.8, competition: 0.72 },
      { phrase: "wildflower first birthday", demand: 0.62, competition: 0.4 },
      { phrase: "two cool birthday invitation", demand: 0.59, competition: 0.35 },
    ],
  },
  stream: {
    id: "stream",
    label: "Stream overlays & emotes",
    short: "Stream",
    color: "var(--chart-5)",
    peakMonths: [],
    productMix: [{ type: "digital", weight: 1 }],
    priceBand: { digital: [4.9, 19.9], pod: [0, 0] },
    style: "neon cyberpunk stream overlay, clean UI frames, vibrant purple and cyan, transparent png ready",
    seeds: [
      { phrase: "animated stream overlay", demand: 0.74, competition: 0.58 },
      { phrase: "vtuber model assets", demand: 0.8, competition: 0.55 },
      { phrase: "cute emote pack", demand: 0.7, competition: 0.62 },
      { phrase: "pastel stream package", demand: 0.61, competition: 0.4 },
    ],
  },
};

export const NICHE_LIST = Object.values(NICHES);

export function seasonality(niche: Niche, date = new Date()) {
  const peaks = NICHES[niche].peakMonths;
  if (peaks.length === 0) return 0.6;
  const m = date.getMonth();
  const dist = Math.min(...peaks.map((p) => Math.min(Math.abs(p - m), 12 - Math.abs(p - m))));
  return Math.max(0.1, 1 - dist * 0.25);
}

export function scoreKeyword(k: { demand: number; competition: number; seasonality: number; trend?: number | null }) {
  const demand = k.trend != null ? k.demand * 0.6 + k.trend * 0.4 : k.demand;
  return Math.round((0.45 * demand + 0.3 * (1 - k.competition) + 0.25 * k.seasonality) * 100) / 100;
}
