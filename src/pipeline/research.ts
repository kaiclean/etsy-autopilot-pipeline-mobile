import { and, asc, desc, eq, inArray, lte, notLike, sql } from "drizzle-orm";
import { keywords, listings, orders } from "@/db/schema";
import { config } from "@/lib/config";
import { emit } from "@/lib/events";
import { activeNiches, isNichePaused, normalizeEtsyVolume, scoreKeyword, seasonality } from "@/lib/niches";
import { realPublishedListingsWhere } from "@/lib/real-orders";
import { getSetting } from "@/lib/settings";
import { etsyApiCompetitionSource } from "./etsy-api";
import { etsyInsightsSource, preferMeasuredDemand } from "./etsy-demand";
import { googleTrendScore, KEYWORD_SOURCES, type KeywordCandidate } from "./sources";
import type { StageFn } from "./types";

const TRENDS_LOOKUPS_PER_RUN = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
const PERFORMANCE_ANALYTICS_FRESHNESS_DAYS = 30;

export const runResearch: StageFn = async (ctx) => {
  const { db, log } = ctx;
  const candidates: KeywordCandidate[] = [];
  for (const source of [etsyInsightsSource, etsyApiCompetitionSource, ...KEYWORD_SOURCES]) {
    try {
      const found = await source.collect({ demo: ctx.demo });
      log(`Source ${source.name}: ${found.length} candidates`);
      candidates.push(...found);
    } catch (e) {
      log(`Source ${source.name} failed: ${(e as Error).message}`, "warn");
    }
  }

  const trends = new Map<string, number>();
  if (config.googleTrendsEnabled) {
    // Rotate through candidates so each run refreshes a different slice.
    const offset = Math.floor(ctx.now.getTime() / DAY_MS) % Math.max(1, candidates.length);
    const slice = [...candidates.slice(offset), ...candidates.slice(0, offset)].slice(0, TRENDS_LOOKUPS_PER_RUN);
    for (const c of slice) {
      const t = await googleTrendScore(c.phrase);
      if (t == null) {
        log(`Google Trends unavailable for “${c.phrase}” (rate-limited or blocked); using seed demand`, "warn");
        break;
      }
      trends.set(c.phrase, t);
      log(`Google Trends “${c.phrase}”: ${t}`);
    }
  } else {
    log("Google Trends disabled (RESEARCH_GOOGLE_TRENDS=false)");
  }

  // A live run re-scores a seeded demo phrase as real research, so it can be selected.
  const claim = ctx.demo ? {} : { isDemo: false };
  const liveOnly = ctx.demo ? undefined : eq(keywords.isDemo, false);
  const rankedCandidates = preferMeasuredDemand(candidates);
  const existingKeywords = rankedCandidates.length
    ? await db
        .select({ id: keywords.id, phrase: keywords.phrase })
        .from(keywords)
        .where(inArray(keywords.phrase, rankedCandidates.map((candidate) => candidate.phrase)))
    : [];
  const keywordIdByPhrase = new Map(existingKeywords.map((keyword) => [keyword.phrase, keyword.id]));
  const performanceKeywordIds = existingKeywords.map((keyword) => keyword.id);
  const performanceCutoff = new Date(ctx.now.getTime() - PERFORMANCE_ANALYTICS_FRESHNESS_DAYS * DAY_MS);
  const realListing = realPublishedListingsWhere(ctx.shopId, performanceCutoff);
  const listingPerformance =
    performanceKeywordIds.length > 0
      ? await db
          .select({
            keywordId: listings.keywordId,
            views: sql<number>`coalesce(sum(${listings.views}), 0)::int`,
            favorites: sql<number>`coalesce(sum(${listings.favorites}), 0)::int`,
          })
          .from(listings)
          .where(and(realListing, inArray(listings.keywordId, performanceKeywordIds)))
          .groupBy(listings.keywordId)
      : [];
  // Views and favorites are lifetime listing counters, so conversion uses lifetime matched sales too.
  const orderPerformance =
    performanceKeywordIds.length > 0
      ? await db
          .select({
            keywordId: listings.keywordId,
            sales: sql<number>`count(${orders.id})::int`,
          })
          .from(listings)
          .innerJoin(
            orders,
            and(
              eq(orders.listingId, listings.id),
              eq(orders.shopId, ctx.shopId),
              eq(orders.matchStatus, "matched"),
              eq(orders.isDemo, false),
              lte(orders.createdAt, ctx.now),
            ),
          )
          .where(and(realListing, inArray(listings.keywordId, performanceKeywordIds), notLike(orders.etsyReceiptId, "dry-%"), notLike(orders.etsyReceiptId, "demo-%")))
          .groupBy(listings.keywordId)
      : [];
  const performance = new Map<number, { views: number; favorites: number; sales: number }>();
  for (const row of listingPerformance) {
    if (row.keywordId == null) continue;
    performance.set(row.keywordId, { views: Number(row.views), favorites: Number(row.favorites), sales: 0 });
  }
  for (const row of orderPerformance) {
    if (row.keywordId == null) continue;
    const current = performance.get(row.keywordId);
    if (current) current.sales = Number(row.sales);
  }
  let upserted = 0;
  for (const c of rankedCandidates) {
    if (isNichePaused(c.niche)) {
      await db
        .insert(keywords)
        .values({
          shopId: ctx.shopId,
          phrase: c.phrase,
          niche: c.niche,
          source: c.source,
          demandScore: c.demand,
          competitionScore: c.competition,
          seasonalityScore: seasonality(c.niche, ctx.now),
          score: 0,
          status: "rejected",
          isDemo: ctx.demo,
        })
        .onConflictDoUpdate({
          target: keywords.phrase,
          set: { status: "rejected", updatedAt: ctx.now, ...claim },
        });
      log(`Paused niche “${c.phrase}” (${c.niche}); not selected`);
      continue;
    }
    const season = seasonality(c.niche, ctx.now);
    const measured = c.searchVolume != null;
    const trend = measured ? null : (trends.get(c.phrase) ?? null);
    const demand = measured ? normalizeEtsyVolume(c.searchVolume ?? 0) : c.demand;
    const score = scoreKeyword({
      demand,
      competition: c.competition,
      seasonality: season,
      trend,
      searchVolume: c.searchVolume,
      performance: performance.get(keywordIdByPhrase.get(c.phrase) ?? -1),
    });
    await db
      .insert(keywords)
      .values({
        shopId: ctx.shopId,
        phrase: c.phrase,
        niche: c.niche,
        source: trend != null ? `${c.source}+google-trends` : c.source,
        demandScore: demand,
        competitionScore: c.competition,
        seasonalityScore: season,
        trendScore: trend,
        score,
        isDemo: ctx.demo,
      })
      .onConflictDoUpdate({
        target: keywords.phrase,
        set: {
          seasonalityScore: season,
          score,
          updatedAt: ctx.now,
          ...claim,
          ...(trend != null ? { trendScore: trend } : {}),
          ...(measured
            ? { demandScore: demand, competitionScore: c.competition, source: c.source, niche: c.niche }
            : {}),
        },
      });
    upserted++;
  }

  const { designsPerRun } = await getSetting(db, "automation");
  const top = await db
    .select({ id: keywords.id, phrase: keywords.phrase, score: keywords.score })
    .from(keywords)
    .where(
      and(eq(keywords.shopId, ctx.shopId), eq(keywords.status, "new"), inArray(keywords.niche, activeNiches().map((n) => n.id)), liveOnly),
    )
    .orderBy(asc(keywords.designFailures), desc(keywords.score))
    .limit(designsPerRun);
  if (top.length) {
    await db
      .update(keywords)
      .set({ status: "selected", updatedAt: ctx.now })
      .where(and(inArray(keywords.id, top.map((t) => t.id)), eq(keywords.status, "new")));
  }
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(keywords).where(and(eq(keywords.shopId, ctx.shopId), eq(keywords.status, "new"), liveOnly));
  log(`Selected for design: ${top.map((t) => `${t.phrase} (${t.score})`).join(", ") || "none"}`);

  if (top.length) {
    await emit(db, {
      type: "research.selected",
      title: `${top.length} niche keyword${top.length > 1 ? "s" : ""} selected`,
      body: top.map((t) => t.phrase).join(" · "),
      severity: "info",
      href: "/pipeline",
    }, ctx.demo);
  }
  return `Scored ${upserted} keywords, selected ${top.length}, ${n} left in backlog`;
};
