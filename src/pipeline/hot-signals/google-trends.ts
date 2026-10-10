import { config } from "@/lib/config";
import { activeNiches } from "@/lib/niches";
import { googleTrendScore } from "../sources";
import { hotFetcher } from "./fetch";
import { hotKeywordSource, type HotSignal } from "./types";

export const GOOGLE_HOT_BUDGET = 5;

export function rotatedGoogleSeeds(now: Date): string[] {
  const niches = activeNiches();
  const day = Math.floor(now.getTime() / 864e5);
  const out: string[] = [];
  for (let round = 0; out.length < GOOGLE_HOT_BUDGET; round++) {
    let added = false;
    for (let offset = 0; offset < niches.length && out.length < GOOGLE_HOT_BUDGET; offset++) {
      const niche = niches[(day + offset) % niches.length];
      if (round >= niche.seeds.length) continue;
      const seed = niche.seeds[(day + round) % niche.seeds.length].phrase;
      if (!out.includes(seed)) {
        out.push(seed);
        added = true;
      }
    }
    if (!added) break;
  }
  return out;
}

export function createGoogleTrendsSource(deps: {
  enabled?: () => boolean;
  score?: typeof googleTrendScore;
  waitForHost?: typeof hotFetcher.waitForHost;
} = {}) {
  return hotKeywordSource("google-trends", async (opts) => {
    if (opts.demo || !(deps.enabled ?? (() => config.googleTrendsEnabled))()) return [];
    const out: HotSignal[] = [];
    for (const phrase of rotatedGoogleSeeds(opts.now)) {
      await (deps.waitForHost ?? hotFetcher.waitForHost)("trends.google.com");
      let metric: number | null;
      try {
        metric = await (deps.score ?? googleTrendScore)(phrase);
      } catch {
        metric = null;
      }
      if (metric == null || !Number.isFinite(metric) || metric < 0 || metric > 1) {
        opts.log("Google Trends hot signals: unavailable or rate limited; stopping provider", "warn");
        break;
      }
      const url = new URL("https://trends.google.com/trends/explore");
      url.searchParams.set("geo", "US");
      url.searchParams.set("date", "today 3-m");
      url.searchParams.set("q", phrase);
      out.push({
        provider: "google-trends", category: null, title: phrase, phrase: phrase.toLowerCase(),
        rank: null, badge: null, label_text: null, metric,
        source_url: url.toString(), fetched_at: opts.now,
      });
    }
    return out;
  });
}

export const googleTrendsSource = createGoogleTrendsSource();
