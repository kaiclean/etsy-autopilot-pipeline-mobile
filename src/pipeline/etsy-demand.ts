import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Niche } from "@/db/schema";
import { NICHE_LIST, normalizeEtsyVolume } from "@/lib/niches";
import type { KeywordCandidate } from "./sources";

/**
 * Operator-supplied Etsy demand (a Marketplace Insights export or the committed fixture).
 * Do not scrape etsy.com search or autocomplete. Measured competition belongs on the
 * official Open API v3 client in etsy-api.ts.
 */
export type EtsyDemandSignal = {
  phrase: string;
  searchVolume: number;
  /** 0–1 competition score, or a raw competing-listing count (values above 1 are log-scaled). */
  competition?: number;
  niche?: Niche;
};

export interface EtsyDemandSource {
  readonly name: string;
  collect(): Promise<EtsyDemandSignal[]>;
}

const NICHES = new Set(NICHE_LIST.map((n) => n.id));

export function normalizeCompetition(value: number | undefined, fallback = 0.5) {
  if (value == null || !Number.isFinite(value)) return fallback;
  if (value <= 1) return Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
  return normalizeEtsyVolume(value);
}

function inferNiche(phrase: string): Niche | undefined {
  const p = phrase.toLowerCase();
  let best: { niche: Niche; len: number } | undefined;
  for (const n of NICHE_LIST) {
    for (const seed of n.seeds) {
      if (p === seed.phrase || p.includes(seed.phrase) || seed.phrase.includes(p)) {
        if (!best || seed.phrase.length > best.len) best = { niche: n.id, len: seed.phrase.length };
      }
    }
  }
  return best?.niche;
}

/**
 * Marketplace Insights-style CSV:
 * keyword,search_volume,competition[,niche]
 * A header row is optional. Lines starting with # are ignored.
 */
export function parseEtsyInsights(text: string): EtsyDemandSignal[] {
  const out: EtsyDemandSignal[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const cols = line.split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
    if (/^(keyword|phrase)$/i.test(cols[0] ?? "")) continue;
    const [phrase, volumeRaw, competitionRaw, nicheRaw] = cols;
    const searchVolume = Number(volumeRaw);
    if (!phrase || !Number.isFinite(searchVolume) || searchVolume < 0) continue;
    const niche = nicheRaw && NICHES.has(nicheRaw as Niche) ? (nicheRaw as Niche) : inferNiche(phrase);
    if (!niche) continue;
    out.push({
      phrase: phrase.toLowerCase(),
      searchVolume,
      competition: competitionRaw ? Number(competitionRaw) : undefined,
      niche,
    });
  }
  return out;
}

export function signalToCandidate(signal: EtsyDemandSignal): KeywordCandidate {
  return {
    phrase: signal.phrase,
    niche: signal.niche ?? inferNiche(signal.phrase) ?? "alpine",
    source: "etsy-insights",
    demand: normalizeEtsyVolume(signal.searchVolume),
    competition: normalizeCompetition(signal.competition),
    searchVolume: signal.searchVolume,
  };
}

/** When the same phrase arrives from seeds and from Etsy, keep the measured volume. */
export function preferMeasuredDemand(candidates: KeywordCandidate[]): KeywordCandidate[] {
  const byPhrase = new Map<string, KeywordCandidate>();
  for (const candidate of candidates) {
    const key = candidate.phrase.toLowerCase();
    const prev = byPhrase.get(key);
    if (!prev) {
      byPhrase.set(key, candidate);
      continue;
    }
    let next = prev;
    const nextVolume = candidate.searchVolume != null;
    const prevVolume = prev.searchVolume != null;
    if (nextVolume && (!prevVolume || (candidate.searchVolume ?? 0) >= (prev.searchVolume ?? 0))) next = candidate;
    const measured = candidate.competitionMeasured ? candidate : prev.competitionMeasured ? prev : undefined;
    if (measured) {
      const source = next.source.includes("etsy-api-v3") ? next.source : `${next.source}+etsy-api-v3`;
      next = { ...next, competition: measured.competition, competitionMeasured: true, source };
    }
    byPhrase.set(key, next);
  }
  return [...byPhrase.values()];
}

/**
 * The committed fixture holds made-up volumes. It is read only for demo shops;
 * a live shop needs ETSY_INSIGHTS_CSV or ETSY_INSIGHTS_PATH from a real export.
 */
export async function loadEtsyDemandSignals(opts: { demo?: boolean } = {}): Promise<EtsyDemandSignal[]> {
  const inline = process.env.ETSY_INSIGHTS_CSV;
  if (inline && inline.trim()) return parseEtsyInsights(inline);
  const fixture = process.env.ETSY_DEMAND_SOURCE === "fixture" && opts.demo === true;
  const file = process.env.ETSY_INSIGHTS_PATH ?? (fixture ? path.join(process.cwd(), "data/etsy-insights.fixture.csv") : "");
  if (!file) return [];
  try {
    return parseEtsyInsights(await readFile(file, "utf8"));
  } catch {
    return [];
  }
}

/** KeywordSource adapter. Returns nothing until a CSV or path is set (or ETSY_DEMAND_SOURCE=fixture in demo mode). */
export const etsyInsightsSource = {
  name: "etsy-insights",
  async collect(opts: { demo?: boolean } = {}): Promise<KeywordCandidate[]> {
    const signals = await loadEtsyDemandSignals(opts);
    return signals.map(signalToCandidate);
  },
};
