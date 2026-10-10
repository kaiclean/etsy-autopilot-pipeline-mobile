import { config } from "@/lib/config";
import { hotFetcher, type HotFetcher } from "./fetch";
import { object } from "./html";
import { hotKeywordSource, type HotSignal } from "./types";

export const PINTEREST_GROWING_URL = "https://api.pinterest.com/v5/trends/keywords/US/top/growing";

export function parsePinterestTrends(body: unknown, now: Date): HotSignal[] {
  const keywords = object(body).keywords;
  if (!Array.isArray(keywords)) return [];
  return keywords.flatMap((raw): HotSignal[] => {
    const row = object(raw);
    if (typeof row.keyword !== "string" || !row.keyword.trim()) return [];
    const phrase = row.keyword.trim();
    return [{
      provider: "pinterest", category: null, title: phrase, phrase: phrase.toLowerCase(),
      rank: null, badge: null, label_text: null,
      metric: typeof row.pct_growth_wow === "number" && Number.isFinite(row.pct_growth_wow) ? row.pct_growth_wow : null,
      source_url: PINTEREST_GROWING_URL, fetched_at: now,
    }];
  });
}

export function createPinterestTrendsSource(deps: { accessToken?: () => string | undefined; fetcher?: HotFetcher } = {}) {
  return hotKeywordSource("pinterest", async (opts) => {
    if (opts.demo) return [];
    const token = (deps.accessToken ?? (() => config.hot.pinterestAccessToken))();
    if (!token) return [];
    const result = await (deps.fetcher ?? hotFetcher).json(PINTEREST_GROWING_URL, {
      log: opts.log, init: { headers: { Authorization: ["Bearer", token].join(" ") } },
    });
    return parsePinterestTrends(result, opts.now);
  });
}

export const pinterestTrendsSource = createPinterestTrendsSource();
