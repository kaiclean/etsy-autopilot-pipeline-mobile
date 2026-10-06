import { and, eq, sql } from "drizzle-orm";
import { getEtsyAdapter } from "@/adapters/etsy";
import { costs, dailyStats, listings, orders } from "@/db/schema";
import { adsEstimateNote, missingAdsDays } from "@/lib/ads-budget";
import { fetchUsdToChf, resolveUsdToChf } from "@/lib/fee-schedule";
import { dayKey } from "@/lib/format";
import { normalizeLedgerEntry, summarizeLedger } from "@/lib/ledger";
import { analyticsOrdersWhere, publishedListingsWhere } from "@/lib/real-orders";
import { getSetting, setSetting } from "@/lib/settings";
import type { StageFn } from "./types";

export const runAnalytics: StageFn = async (ctx) => {
  const { db, log } = ctx;
  const etsy = await getEtsyAdapter(db, ctx.random, "read");
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
  for (const l of published) {
    const s = stats[l.etsyListingId!];
    if (!s) continue;
    const dv = Math.max(0, s.views - l.views);
    const df = Math.max(0, s.favorites - l.favorites);
    if (dv || df) {
      await db.update(listings).set({ views: s.views, favorites: s.favorites }).where(eq(listings.id, l.id));
      dViews += dv;
      dFavs += df;
    }
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

  const [automation, feeFx] = await Promise.all([getSetting(db, "automation"), getSetting(db, "feeFx")]);
  let fx = resolveUsdToChf({ stored: feeFx?.usdToChf, storedAsOf: feeFx?.asOf });
  if (process.env.FX_REFRESH === "true") {
    try {
      const quote = await fetchUsdToChf();
      if (quote) {
        await setSetting(db, "feeFx", quote);
        fx = { rate: quote.usdToChf, source: "settings", asOf: quote.asOf };
        log(`USD→CHF ${quote.usdToChf} as of ${quote.asOf} (ECB via frankfurter.app)`);
      }
    } catch (error) {
      log(`FX refresh failed, keeping ${fx.rate}: ${(error as Error).message}`, "warn");
    }
  }

  if (etsy.mode === "live") {
    try {
      const since = new Date(ctx.now.getTime() - 120 * 864e5);
      const raw = await etsy.getLedgerEntries({ since, until: ctx.now });
      const normalized = raw.flatMap((entry) => {
        const row = normalizeLedgerEntry(entry, fx.rate);
        return row ? [row] : [];
      });
      const { shopRenewals } = summarizeLedger(normalized);
      const existingNotes = new Set(
        (
          await db
            .select({ note: costs.note })
            .from(costs)
            .where(and(eq(costs.shopId, ctx.shopId), eq(costs.kind, "listing_fee")))
        ).map((row) => row.note),
      );
      let renewals = 0;
      for (const renewal of shopRenewals) {
        const note = `Etsy ${renewal.ledgerType} ledger ${renewal.entryId}${renewal.assumedChf ? " (currency assumed CHF)" : ""}`;
        if (existingNotes.has(note)) continue;
        await db.insert(costs).values({ shopId: ctx.shopId, kind: "listing_fee", amountChf: renewal.amountChf, note, isDemo: demo });
        renewals++;
      }
      if (renewals) log(`Booked ${renewals} Etsy listing/renewal fee(s) from the payment-account ledger`);
    } catch (error) {
      log(`Ledger renewal fees unavailable: ${(error as Error).message}`, "warn");
    }
  }

  if (automation.adsEnabled && automation.dailyAdsCapChf > 0) {
    const notes = (
      await db.select({ note: costs.note }).from(costs).where(and(eq(costs.shopId, ctx.shopId), eq(costs.kind, "ads")))
    ).map((row) => row.note);
    const days = missingAdsDays({ today, enabledAt: automation.adsEnabledAt, existingNotes: notes });
    for (const date of days) {
      await db.insert(costs).values({
        shopId: ctx.shopId,
        kind: "ads",
        amountChf: automation.dailyAdsCapChf,
        note: adsEstimateNote(date),
        isDemo: demo,
        createdAt: new Date(`${date}T12:00:00Z`),
      });
    }
    if (days.length) {
      log(
        `Booked Etsy Ads daily cap as an estimate for ${days.length} day(s) at CHF ${automation.dailyAdsCapChf.toFixed(2)} (not measured spend; set the cap in Etsy)`,
      );
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
