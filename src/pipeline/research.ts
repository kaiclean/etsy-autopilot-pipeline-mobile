import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { keywords, listings, orders } from "@/db/schema";
import { config } from "@/lib/config";
import { emit } from "@/lib/events";
import { activeNiches, isNichePaused, normalizeEtsyVolume, scoreKeyword, seasonality } from "@/lib/niches";
import { notFakeReceiptWhere, realPublishedListingsWhere, revenueEligibleOrderWhere } from "@/lib/real-orders";
import { getSetting } from "@/lib/settings";
import { keywordHasUndeliverablePromise } from "@/lib/delivery";
import { etsyApiCompetitionSource } from "./etsy-api";
import { etsyInsightsSource, preferMeasuredDemand } from "./etsy-demand";
import { googleTrendScore, KEYWORD_SOURCES, type KeywordCandidate } from "./sources";
import { loadHotSignals, mergeHotKeywords } from "./hot-signals";
import type { StageFn } from "./types";
import { themeCandidates } from "@/lib/themes";
import { generateIdeaCandidates } from "@/lib/brain/idea-feed";

const TRENDS_LOOKUPS_PER_RUN = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
const PERFORMANCE_ANALYTICS_FRESHNESS_DAYS = 30;

export const runResearch: StageFn = async (ctx) => {
  const { db, log } = ctx;
  const hot = ctx.demo ? [] : await loadHotSignals(db, ctx.shopId, ctx.now);
  const hotBoost = new Map<string, number>();
  for (const signal of hot) {
    hotBoost.set(signal.phrase, Math.max(hotBoost.get(signal.phrase) ?? 0, signal.score * 0.15));
  }
  const candidates: KeywordCandidate[] = [];
  for (const source of [etsyInsightsSource, etsyApiCompetitionSource, ...KEYWORD_SOURCES]) {
    try {
      const found = await source.collect({ demo: ctx.demo });
      const eligible = found.filter((candidate) => !keywordHasUndeliverablePromise(candidate.phrase));
      log(`Source ${source.name}: ${eligible.length} eligible of ${found.length} candidates`);
      candidates.push(...eligible);
    } catch (e) {
      log(`Source ${source.name} failed: ${(e as Error).message}`, "warn");
    }
  }

  try {
    const themed = await themeCandidates(db);
    const known = new Set(candidates.map((c) => c.phrase));
    const fresh = themed.filter((c) => !known.has(c.phrase));
    candidates.push(...fresh);
    log(`Source themes: ${fresh.length} phrases from the theme registry`);
  } catch (e) {
    log(`Source themes failed: ${(e as Error).message}`, "warn");
  }

  const trends = new Map<string, number>();
  if (config.googleTrendsEnabled) {
    // Rotate through candidates so each run refreshes a different slice.
    const offset = Math.floor(ctx.now.getTime() / DAY_MS) % Math.max(1, candidates.length);
    const slice = [...candidates.slice(offset), ...candidates.slice(0, offset)].slice(0, TRENDS_LOOKUPS_PER_RUN);
    let consecutiveFailures = 0;
    for (const c of slice) {
      if (consecutiveFailures >= 3) {
        log(`Google Trends: ${consecutiveFailures} consecutive failures, skipping remaining lookups`, "warn");
        break;
      }
      let t: number | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        t = await googleTrendScore(c.phrase);
        if (t != null) break;
        if (attempt < 2) {
          const delay = 1000 * 2 ** attempt; // 1s, 2s
          log(`Google Trends rate-limited for "${c.phrase}", retrying in ${delay}ms (attempt ${attempt + 1}/3)`, "warn");
          await new Promise((r) => setTimeout(r, delay));
        }
      }
      if (t == null) {
        consecutiveFailures++;
        log(`Google Trends unavailable for "${c.phrase}" after retries; using seed demand`, "warn");
        continue;
      }
      consecutiveFailures = 0;
      trends.set(c.phrase, t);
      log(`Google Trends "${c.phrase}": ${t}`);
    }
  } else {
    log("Google Trends disabled (RESEARCH_GOOGLE_TRENDS=false)");
  }

  // A live run re-scores a seeded demo phrase as real research, so it can be selected.
  const claim = ctx.demo ? {} : { isDemo: false };
  const liveOnly = ctx.demo ? undefined : eq(keywords.isDemo, false);
  const unresolved = await db.select({ id: keywords.id, phrase: keywords.phrase }).from(keywords).where(and(
    eq(keywords.shopId, ctx.shopId),
    inArray(keywords.status, ["new", "selected"]),
    liveOnly,
  ));
  for (const keyword of unresolved) {
    if (!keywordHasUndeliverablePromise(keyword.phrase)) continue;
    await db.update(keywords).set({ status: "rejected", updatedAt: ctx.now }).where(eq(keywords.id, keyword.id));
    log(`Rejected existing keyword “${keyword.phrase}”: its file claim is not deliverable`, "warn");
  }
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
              revenueEligibleOrderWhere(),
              lte(orders.createdAt, ctx.now),
            ),
          )
          .where(and(realListing, inArray(listings.keywordId, performanceKeywordIds), notFakeReceiptWhere()))
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
    const score = Math.min(1, scoreKeyword({
      demand,
      competition: c.competition,
      seasonality: season,
      trend,
      searchVolume: c.searchVolume,
      performance: performance.get(keywordIdByPhrase.get(c.phrase) ?? -1),
    }) + (hotBoost.get(c.phrase) ?? 0));
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
        themeId: c.themeId ?? null,
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
            : {
              demandScore: sql`CASE WHEN ${keywords.source} LIKE 'hot:%' THEN ${demand} ELSE ${keywords.demandScore} END`,
              competitionScore: sql`CASE WHEN ${keywords.source} LIKE 'hot:%' THEN ${c.competition} ELSE ${keywords.competitionScore} END`,
              source: sql`CASE WHEN ${keywords.source} LIKE 'hot:%' THEN ${trend != null ? `${c.source}+google-trends` : c.source} ELSE ${keywords.source} END`,
            }),
        },
      });
    upserted++;
  }

  await mergeHotKeywords(ctx, hot);

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
  // Daily idea step: rule-based (no AI spend). Candidates wait in the Brain for Kai.
  let ideaNote = "";
  try {
    const added = await generateIdeaCandidates(db, ctx.now);
    ideaNote = `, ${added} new idea candidate${added === 1 ? "" : "s"} for the Brain`;
    log(`Idea feed: ${added} new candidates waiting in /brain/ideas`);
  } catch (e) {
    log(`Idea feed failed: ${(e as Error).message}`, "warn");
  }
  return `Scored ${upserted} keywords, selected ${top.length}, ${n} left in backlog${ideaNote}`;
};
