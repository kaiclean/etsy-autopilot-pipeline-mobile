import { and, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import type { DB } from "@/db";
import { hotSignalFetches, hotSignals, keywords } from "@/db/schema";
import { keywordHasUndeliverablePromise } from "@/lib/delivery";
import { mapSignalNiche } from "@/lib/niches";
import { amazonSource } from "./amazon";
import { etsyBadgesSource } from "./etsy-badges";
import { googleTrendsSource } from "./google-trends";
import { pinterestTrendsSource } from "./pinterest-trends";
import { HOT_PROVIDERS, observedScore, type HotKeywordSource, type HotSignal, type RankedHotSignal } from "./types";
import { stageResult, type StageContext, type StageFn } from "../types";

export * from "./types";

const HOUR_MS = 60 * 60 * 1000;
export const HOT_SOURCES: HotKeywordSource[] = [amazonSource, etsyBadgesSource, googleTrendsSource, pinterestTrendsSource];

export function rankHotSignals(signals: HotSignal[]): RankedHotSignal[] {
  const unique = new Map<string, HotSignal>();
  for (const signal of signals) {
    if (!HOT_PROVIDERS.includes(signal.provider) || !signal.title.trim() || !signal.phrase.trim()) continue;
    if (!Number.isFinite(signal.fetched_at.getTime())) continue;
    let url: URL;
    try { url = new URL(signal.source_url); } catch { continue; }
    const hostAllowed = {
      amazon: ["www.amazon.com", "www.amazon.de"],
      etsy: ["www.etsy.com", "openapi.etsy.com"],
      "google-trends": ["trends.google.com"],
      pinterest: ["trends.pinterest.com", "api.pinterest.com"],
    }[signal.provider].includes(url.hostname);
    if (!hostAllowed || url.protocol !== "https:" || url.username || url.password || url.port) continue;
    if (signal.rank != null && (!Number.isInteger(signal.rank) || signal.rank < 1)) continue;
    if (signal.metric != null && !Number.isFinite(signal.metric)) continue;
    const phrase = signal.phrase.trim().toLowerCase().replace(/\s+/g, " ");
    if (!mapSignalNiche(phrase) || keywordHasUndeliverablePromise(phrase)) continue;
    const key = `${signal.provider}\0${signal.source_url}\0${signal.fetched_at.toISOString().slice(0, 10)}`;
    const previous = unique.get(key);
    if (!previous || previous.fetched_at < signal.fetched_at) unique.set(key, { ...signal, phrase });
  }
  const providers = new Map<string, Set<string>>();
  for (const signal of unique.values()) {
    // Merely being returned in a search is not demand evidence.
    if (observedScore(signal) <= 0 && !signal.label_text) continue;
    const agreement = providers.get(signal.phrase) ?? new Set();
    agreement.add(signal.provider);
    providers.set(signal.phrase, agreement);
  }
  return [...unique.values()].map((signal) => ({
    ...signal,
    niche: mapSignalNiche(signal.phrase)!,
    score: observedScore(signal) > 0
      ? Math.min(1, observedScore(signal) + Math.max(0, (providers.get(signal.phrase)?.size ?? 0) - 1) * 0.1)
      : 0,
  })).sort((a, b) => b.score - a.score || a.phrase.localeCompare(b.phrase));
}

export async function loadHotSignals(db: DB, shopId: string, now: Date): Promise<RankedHotSignal[]> {
  const rows = await db.select({
    provider: hotSignals.provider, category: hotSignals.category, title: hotSignals.title,
    phrase: hotSignals.phrase, rank: hotSignals.rank, badge: hotSignals.badge,
    label_text: hotSignals.labelText, metric: hotSignals.metric,
    source_url: hotSignals.sourceUrl, fetched_at: hotSignals.fetchedAt,
  }).from(hotSignals).where(and(
    or(isNull(hotSignals.shopId), eq(hotSignals.shopId, shopId)),
    gte(hotSignals.fetchedAt, new Date(now.getTime() - 24 * HOUR_MS)),
    lte(hotSignals.fetchedAt, now),
  ));
  return rankHotSignals(rows.filter((row): row is HotSignal => HOT_PROVIDERS.includes(row.provider as HotSignal["provider"])));
}

export async function scanHotSignals(ctx: StageContext, sources = HOT_SOURCES) {
  if (ctx.demo) {
    ctx.log("Hot scan skipped in demo mode; dashboard examples are fixtures, not live demand");
    return { signals: [] as RankedHotSignal[], failed: 0 };
  }
  const cutoff = new Date(ctx.now.getTime() - 20 * HOUR_MS);
  let failed = 0;
  for (const source of sources) {
    const [cached] = await ctx.db.select({ fetchedAt: hotSignalFetches.fetchedAt })
      .from(hotSignalFetches).where(and(eq(hotSignalFetches.provider, source.name), gte(hotSignalFetches.fetchedAt, cutoff), lte(hotSignalFetches.fetchedAt, ctx.now)));
    if (cached) {
      ctx.log(`Hot ${source.name}: cached (${cached.fetchedAt.toISOString()})`);
      continue;
    }
    try {
      const found = await source.collectSignals({ now: ctx.now, demo: false, log: ctx.log });
      const ranked = rankHotSignals(found.filter((signal) => signal.provider === source.name && signal.fetched_at <= ctx.now && signal.fetched_at >= cutoff));
      if (ranked.length) {
        await ctx.db.insert(hotSignals).values(ranked.map((signal) => ({
          provider: signal.provider, category: signal.category, title: signal.title,
          phrase: signal.phrase, niche: signal.niche, rank: signal.rank,
          badge: signal.badge, labelText: signal.label_text, metric: signal.metric,
          score: signal.score, sourceUrl: signal.source_url, fetchedAt: signal.fetched_at,
        }))).onConflictDoNothing();
      }
      await ctx.db.insert(hotSignalFetches).values({ provider: source.name, fetchedAt: ctx.now })
        .onConflictDoUpdate({ target: hotSignalFetches.provider, set: { fetchedAt: ctx.now } });
      ctx.log(`Hot ${source.name}: ${ranked.length} observations`);
    } catch {
      failed++;
      ctx.log(`Hot ${source.name} failed; other providers continue`, "warn");
    }
  }
  return { signals: await loadHotSignals(ctx.db, ctx.shopId, ctx.now), failed };
}

/** No seasonality, seed demand, or assumed competition contributes to a hot-only keyword. */
export async function mergeHotKeywords(ctx: StageContext, signals: RankedHotSignal[]) {
  let merged = 0;
  const phrases = new Set<string>();
  for (const signal of signals) {
    if (signal.score <= 0 || phrases.has(signal.phrase)) continue;
    phrases.add(signal.phrase);
    await ctx.db.insert(keywords).values({
      shopId: ctx.shopId, phrase: signal.phrase, niche: signal.niche,
      source: `hot:${signal.provider}`, score: signal.score, isDemo: ctx.demo,
    }).onConflictDoUpdate({
      target: keywords.phrase,
      // Preserve non-hot measured demand and keyword lifecycle. The research pass adds its optional boost.
      set: {
        score: sql`CASE WHEN ${keywords.source} LIKE 'hot:%' THEN ${signal.score} ELSE ${keywords.score} END`,
        updatedAt: ctx.now,
      },
      setWhere: and(eq(keywords.shopId, ctx.shopId), eq(keywords.isDemo, ctx.demo)),
    });
    merged++;
  }
  return merged;
}

export const runHot: StageFn = async (ctx) => {
  const { signals, failed } = await scanHotSignals(ctx);
  const merged = await mergeHotKeywords(ctx, signals);
  return stageResult(`Hot scan: ${signals.length} observed signals, ${merged} keywords merged; no sales estimated`, failed ? "warning" : "success");
};
