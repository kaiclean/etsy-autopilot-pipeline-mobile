import { and, eq, like, sql } from "drizzle-orm";
import { getEtsyAdapter } from "@/adapters/etsy";
import { costs, dailyStats, listings, orders } from "@/db/schema";
import { dayKey } from "@/lib/format";
import { analyticsOrdersWhere, publishedListingsWhere } from "@/lib/real-orders";
import { getSetting } from "@/lib/settings";
import type { StageFn } from "./types";

export const runAnalytics: StageFn = async (ctx) => {
  const { db, log } = ctx;
  const etsy = await getEtsyAdapter(db, ctx.random, "read", ctx.shopId);
  if (!ctx.demo && etsy.mode !== "live") throw new Error("Live Etsy analytics unavailable: connect this shop before syncing");
  const published = await db
    .select({
      id: listings.id,
      etsyListingId: listings.etsyListingId,
      views: listings.views,
      favorites: listings.favorites,
    })
    .from(listings)
    .where(publishedListingsWhere(ctx.shopId));

  const stats = await etsy.getListingStats(
    published.map((l) => ({ etsyListingId: l.etsyListingId!, views: l.views, favorites: l.favorites })),
  );
  let dViews = 0;
  let dFavs = 0;
  let unavailable = 0;
  for (const l of published) {
    const s = stats[l.etsyListingId!];
    if (!s) {
      unavailable++;
      await db.update(listings).set({ analyticsCheckedAt: null })
        .where(and(eq(listings.id, l.id), eq(listings.shopId, ctx.shopId)));
      continue;
    }
    const hasViews = typeof s.views === "number" && Number.isSafeInteger(s.views) && s.views >= 0;
    const hasFavorites = typeof s.favorites === "number" && Number.isSafeInteger(s.favorites) && s.favorites >= 0;
    if (!hasViews || !hasFavorites) unavailable++;
    // Keep last known counters, but do not advertise partial observations as fresh conversion evidence.
    await db.update(listings).set({
      ...(hasViews ? { views: s.views! } : {}),
      ...(hasFavorites ? { favorites: s.favorites! } : {}),
      analyticsCheckedAt: hasViews && hasFavorites ? ctx.now : null,
    }).where(and(eq(listings.id, l.id), eq(listings.shopId, ctx.shopId)));
    if (hasViews) dViews += Math.max(0, s.views! - l.views);
    if (hasFavorites) dFavs += Math.max(0, s.favorites! - l.favorites);
  }

  const today = dayKey(ctx.now);
  const demo = ctx.demo;
  const [row] = await db
    .select()
    .from(dailyStats)
    .where(and(eq(dailyStats.date, today), eq(dailyStats.isDemo, demo)));
  if (row) {
    await db
      .update(dailyStats)
      .set({ views: row.views + dViews, favorites: row.favorites + dFavs })
      .where(eq(dailyStats.id, row.id));
  } else {
    await db.insert(dailyStats).values({ date: today, views: dViews, favorites: dFavs, isDemo: demo });
  }
  log(`Views +${dViews}, favorites +${dFavs} across ${published.length} live listings (${etsy.mode})`);
  if (unavailable) log(`${unavailable} listing(s) have unavailable metrics; historical counters preserved and conversion feedback disabled`, "warn");

  const automation = await getSetting(db, "automation");
  if (automation.adsEnabled && automation.dailyAdsCapChf > 0) {
    const note = `Etsy Ads budget ${today}`;
    const [already] = await db
      .select({ id: costs.id })
      .from(costs)
      .where(and(eq(costs.shopId, ctx.shopId), eq(costs.kind, "ads_estimate"), like(costs.note, `${note}%`)));
    if (!already) {
      await db.insert(costs).values({ shopId: ctx.shopId, kind: "ads_estimate", amountChf: automation.dailyAdsCapChf, note, isDemo: demo });
      log(`Recorded estimated Etsy Ads budget CHF ${automation.dailyAdsCapChf.toFixed(2)} (actual spend is not available from the Etsy Ads API)`);
    }
  }

  const since = new Date(ctx.now.getTime() - 30 * 864e5);
  const [agg] = await db
    .select({
      revenue: sql<number>`coalesce(sum(${orders.totalChf}),0)::float`,
      profit: sql<number>`coalesce(sum(${orders.profitChf}),0)::float`,
      n: sql<number>`count(*)::int`,
    })
    .from(orders)
    .where(analyticsOrdersWhere(ctx.shopId, since));
  return `30d: ${agg.n} orders, revenue CHF ${Number(agg.revenue).toFixed(2)}, profit after fees CHF ${Number(agg.profit).toFixed(2)} · +${dViews} views`;
};
