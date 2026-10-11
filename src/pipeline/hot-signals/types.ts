import type { Niche } from "@/db/schema";
import { mapSignalNiche } from "@/lib/niches";
import type { KeywordCandidate, KeywordSource } from "../sources";

export const HOT_PROVIDERS = ["amazon", "etsy", "google-trends", "pinterest"] as const;
export type HotProvider = (typeof HOT_PROVIDERS)[number];

export type HotSignal = {
  provider: HotProvider;
  category: string | null;
  title: string;
  phrase: string;
  rank: number | null;
  badge: string | null;
  label_text: string | null;
  metric: number | null;
  source_url: string;
  fetched_at: Date;
};

export type RankedHotSignal = HotSignal & { niche: Niche; score: number };
export type HotCollectOptions = {
  now: Date;
  demo?: boolean;
  log: (message: string, level?: "info" | "warn" | "error") => void;
};

export interface HotKeywordSource extends KeywordSource {
  readonly name: HotProvider;
  collectSignals(opts: HotCollectOptions): Promise<HotSignal[]>;
}

export function observedScore(signal: HotSignal): number {
  let score = 0;
  if (signal.rank != null && Number.isInteger(signal.rank) && signal.rank > 0) {
    score += 0.5 / Math.sqrt(signal.rank);
  }
  if (signal.badge) score += 0.3;
  if (signal.label_text) score += 0.1;
  if (signal.metric != null && Number.isFinite(signal.metric)) {
    if (signal.provider === "google-trends") score += 0.2 * Math.max(0, Math.min(1, signal.metric));
    if (signal.provider === "pinterest") score += 0.2 * Math.max(0, Math.min(1, signal.metric / 100));
  }
  return score;
}

export function hotKeywordSource(
  name: HotProvider,
  collectSignals: HotKeywordSource["collectSignals"],
): HotKeywordSource {
  return {
    name,
    collectSignals,
    async collect(opts) {
      const signals = await collectSignals({ now: new Date(), demo: opts?.demo, log: () => {} });
      return signals.flatMap((signal): KeywordCandidate[] => {
        const niche = mapSignalNiche(signal.phrase);
        const score = observedScore(signal);
        return niche && score > 0
          ? [{ phrase: signal.phrase, niche, source: `hot:${name}`, demand: score, competition: 0 }]
          : [];
      });
    },
  };
}
