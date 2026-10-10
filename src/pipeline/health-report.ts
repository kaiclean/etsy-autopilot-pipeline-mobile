import { and, eq, gte, inArray, lte } from "drizzle-orm";
import type { DB } from "@/db";
import { costs, dailyStats, healthReports, listings, orders, type HealthReportPayload, type HealthSuggestion } from "@/db/schema";
import { emit } from "@/lib/events";
import { calculateFees, round2 } from "@/lib/fees";
import { dayKey } from "@/lib/format";
import { notFakeReceiptWhere } from "@/lib/real-orders";
import { weeklyWindow } from "@/lib/utc-day";

const DAY_MS = 864e5;

export type SuggestionInput = {
  id: number;
  title: string;
  views: number;
  favorites: number;
  sales: number;
  ageDays: number;
};

/** Refresh when a live listing is getting attention without sales. Retire when it is quiet. */
export function suggestListingActions(rows: SuggestionInput[]): HealthSuggestion[] {
  const suggestions: HealthSuggestion[] = [];
  for (const row of rows) {
    if (row.sales > 0) continue;
    if (row.ageDays >= 21 && row.views < 10 && row.favorites === 0) {
      suggestions.push({
        listingId: row.id,
        title: row.title,
        action: "retire",
        reason: `Live for ${row.ageDays} days with ${row.views} views and no favorites or sales.`,
      });
      continue;
    }
    if (row.favorites >= 3) {
      suggestions.push({
        listingId: row.id,
        title: row.title,
        action: "refresh",
        reason: `${row.favorites} favorites and no sales. Refresh the photos or the first line of the title.`,
      });
      continue;
    }
    if (row.views >= 15) {
      suggestions.push({
        listingId: row.id,
        title: row.title,
        action: "refresh",
        reason: `${row.views} views, ${row.favorites} favorites, no sales. Refresh tags or mockups.`,
      });
    }
  }
  return suggestions;
}

function isRealPublishedListing(row: { isDemo: boolean; publishMode: string | null; etsyListingId: string | null; status: string }) {
  if (row.isDemo || row.status !== "published") return false;
  if (row.publishMode === "dry-run") return false;
  if (!row.etsyListingId || row.etsyListingId.startsWith("dry-") || row.etsyListingId.startsWith("demo-")) return false;
  return true;
}

/** Shop totals for the trailing week. Demo rows and dry-run receipt ids are left out. */
export async function buildHealthReport(db: DB, shopId: string, now: Date): Promise<HealthReportPayload> {
  const window = weeklyWindow(now);
  const startKey = dayKey(window.start);
  const endKey = dayKey(window.end);

  const [realOrders, statRows, adRows, listingRows] = await Promise.all([
    db.select().from(orders).where(and(eq(orders.shopId, shopId), eq(orders.isDemo, false), notFakeReceiptWhere())),
    db.select().from(dailyStats).where(eq(dailyStats.isDemo, false)),
    db
      .select()
      .from(costs)
      .where(and(eq(costs.shopId, shopId), inArray(costs.kind, ["ads_estimate", "ads_actual"]), eq(costs.isDemo, false), gte(costs.createdAt, window.start), lte(costs.createdAt, window.end))),
    db.select().from(listings).where(eq(listings.shopId, shopId)),
  ]);
  const orderRows = realOrders.filter((order) => order.createdAt >= window.start && order.createdAt <= window.end);

  let vat = 0;
  let pod = 0;
  let profit = 0;
  const salesByListing = new Map<number, number>();
  for (const order of realOrders) {
    if (order.listingId) salesByListing.set(order.listingId, (salesByListing.get(order.listingId) ?? 0) + 1);
  }
  for (const order of orderRows) {
    const qty = Math.max(order.quantity, 1);
    const fees = calculateFees({
      priceChf: order.totalChf / qty,
      quantity: order.quantity,
      podCostChf: order.podCostChf / qty,
      offsiteAds: order.offsiteAdsChf > 0,
    });
    vat += fees.vatOnFeesChf;
    pod += order.podCostChf;
    profit += order.profitChf;
  }

  let views = 0;
  let favorites = 0;
  for (const stat of statRows) {
    if (stat.date < startKey || stat.date > endKey) continue;
    views += stat.views;
    favorites += stat.favorites;
  }

  const suggestions = suggestListingActions(
    listingRows.filter(isRealPublishedListing).map((listing) => {
      const opened = listing.publishedAt ?? listing.createdAt;
      return {
        id: listing.id,
        title: listing.title,
        views: listing.views,
        favorites: listing.favorites,
        sales: salesByListing.get(listing.id) ?? 0,
        ageDays: Math.floor((now.getTime() - opened.getTime()) / DAY_MS),
      };
    }),
  );

  return {
    weekStart: window.weekStart,
    windowStart: window.start.toISOString(),
    windowEnd: window.end.toISOString(),
    views,
    favorites,
    sales: orderRows.length,
    profitChf: round2(profit),
    vatChf: round2(vat),
    podCostChf: round2(pod),
    adsChf: round2(adRows.reduce((sum, row) => sum + row.amountChf, 0)),
    adsEstimateChf: round2(adRows.filter((row) => row.kind === "ads_estimate").reduce((sum, row) => sum + row.amountChf, 0)),
    adsActualChf: round2(adRows.filter((row) => row.kind === "ads_actual").reduce((sum, row) => sum + row.amountChf, 0)),
    suggestions,
  };
}

/** Upserts the Monday report. The web-push fires on the first insert for that week only. */
export async function publishHealthReport(db: DB, shopId: string, now: Date) {
  const payload = await buildHealthReport(db, shopId, now);
  const inserted = await db
    .insert(healthReports)
    .values({ shopId, weekStart: payload.weekStart, payload })
    .onConflictDoNothing({ target: [healthReports.shopId, healthReports.weekStart] })
    .returning({ id: healthReports.id });

  if (inserted.length === 0) {
    await db
      .update(healthReports)
      .set({ payload, updatedAt: now })
      .where(and(eq(healthReports.shopId, shopId), eq(healthReports.weekStart, payload.weekStart)));
  } else {
    const refresh = payload.suggestions.filter((item) => item.action === "refresh").length;
    const retire = payload.suggestions.filter((item) => item.action === "retire").length;
    await emit(
      db,
      {
        type: "health.report",
        title: "Weekly shop health",
        body: `${payload.views} views · ${payload.favorites} favorites · ${payload.sales} sales · profit CHF ${payload.profitChf.toFixed(2)} after fees. VAT CHF ${payload.vatChf.toFixed(2)}, POD CHF ${payload.podCostChf.toFixed(2)}, ad estimate CHF ${(payload.adsEstimateChf ?? payload.adsChf).toFixed(2)}, actual ads CHF ${(payload.adsActualChf ?? 0).toFixed(2)}. ${refresh} to refresh, ${retire} to retire.`,
        severity: "info",
        href: "/",
        shopId,
      },
      false,
    );
  }

  return { payload, pushed: inserted.length > 0 };
}
