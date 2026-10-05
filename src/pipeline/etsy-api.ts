import type { Niche } from "@/db/schema";
import { config } from "@/lib/config";
import { activeNiches, normalizeEtsyVolume } from "@/lib/niches";
import type { KeywordCandidate, KeywordSource } from "./sources";

/** Official Open API v3 origin. etsy.com HTML, search, and autocomplete are out of bounds. */
export const ETSY_OPENAPI_ORIGIN = "https://openapi.etsy.com";

const LISTINGS_ACTIVE = "/v3/application/listings/active";

export function etsyActiveListingsUrl(keyword: string) {
  const url = new URL(LISTINGS_ACTIVE, ETSY_OPENAPI_ORIGIN);
  url.searchParams.set("keywords", keyword);
  url.searchParams.set("limit", "1");
  return url;
}

/** Reject anything that is not the official API. Scraping etsy.com violates the API Terms. */
export function assertOfficialEtsyApi(url: string) {
  const parsed = new URL(url);
  if (parsed.hostname !== "openapi.etsy.com" || parsed.protocol !== "https:") {
    throw new Error("Etsy research must use https://openapi.etsy.com. Scraping etsy.com is not allowed.");
  }
  if (!parsed.pathname.startsWith("/v3/application/")) {
    throw new Error("Etsy research must call Open API v3 application endpoints.");
  }
}

export function competitionFromListingCount(count: number) {
  return normalizeEtsyVolume(count);
}

/**
 * Listing count for a keyword via GET /v3/application/listings/active.
 * This is competition, not search volume. Volume still comes from an operator CSV or fixture.
 */
export async function fetchActiveListingCount(
  keyword: string,
  opts: { apiKey: string; fetchImpl?: typeof fetch },
): Promise<number | null> {
  const url = etsyActiveListingsUrl(keyword);
  assertOfficialEtsyApi(url.toString());
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(url, {
      headers: { "x-api-key": opts.apiKey, "User-Agent": "EtsyAutopilot" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { count?: number };
    return typeof body.count === "number" && body.count >= 0 ? body.count : null;
  } catch {
    return null;
  }
}

const LOOKUPS_PER_RUN = 8;

export function createEtsyApiCompetitionSource(deps: {
  enabled?: boolean;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  phrases?: { phrase: string; niche: Niche }[];
} = {}): KeywordSource {
  return {
    name: "etsy-api-v3",
    async collect() {
      const enabled = deps.enabled ?? process.env.ETSY_API_COMPETITION === "true";
      const apiKey = deps.apiKey ?? (config.etsy.apiKey && config.etsy.sharedSecret ? `${config.etsy.apiKey}:${config.etsy.sharedSecret}` : config.etsy.apiKey);
      if (!enabled || !apiKey) return [];
      const phrases =
        deps.phrases ??
        activeNiches().flatMap((niche) => niche.seeds.map((seed) => ({ phrase: seed.phrase, niche: niche.id }))).slice(0, LOOKUPS_PER_RUN);
      const out: KeywordCandidate[] = [];
      for (const row of phrases) {
        const count = await fetchActiveListingCount(row.phrase, { apiKey, fetchImpl: deps.fetchImpl });
        if (count == null) continue;
        out.push({
          phrase: row.phrase,
          niche: row.niche,
          source: "etsy-api-v3",
          demand: 0.5,
          competition: competitionFromListingCount(count),
          competitionMeasured: true,
        });
      }
      return out;
    },
  };
}

/** Off unless ETSY_API_COMPETITION=true and an Etsy API key is configured. */
export const etsyApiCompetitionSource = createEtsyApiCompetitionSource();
