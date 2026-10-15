import { and, eq, gte, inArray, lte } from "drizzle-orm";
import type { DB } from "@/db";
import { costs, healthReports, listings, orders, type HealthSuggestion } from "@/db/schema";
import { emit } from "@/lib/events";
import { calculateFees, round2 } from "@/lib/fees";
import { notFakeReceiptWhere, revenueEligibleOrderWhere } from "@/lib/real-orders";
import { weeklyWindow } from "@/lib/utc-day";
import { hasFreshListingSnapshot, RECOMMENDATION_FRESHNESS_MS, type EvidenceHealthReport } from "@/lib/operator-recommendations";

const DAY_MS = 864e5;

export type SuggestionInput = {
  id: number;
  title: string;
  views: number;
  favorites: number;
  sales: number;
  ageDays: number;
  analyticsCheckedAt?: Date | null;
};

/** Review candidates only; cumulative snapshots do not establish period conversion or causality. */
export function suggestListingActions(rows: SuggestionInput[], now = new Date()): HealthSuggestion[] {
  const suggestions: HealthSuggestion[] = [];
  for (const row of rows) {
    if (!hasFreshListingSnapshot(row.analyticsCheckedAt, now)) continue;
    if (row.sales > 0) continue;
    const evidence = `Snapshot checked ${row.analyticsCheckedAt!.toISOString()}; cumulative views/favorites, not period conversion. Human review required; no changes applied.`;
    if (row.ageDays >= 21 && row.views < 10 && row.favorites === 0) {
      suggestions.push({
        listingId: row.id,
        title: row.title,
        action: "retire",
        reason: `Consider retiring: live for ${row.ageDays} days with ${row.views} views, no favorites and no eligible paid sales. Verify order coverage first. ${evidence}`,
      });
      continue;
    }
    if (row.favorites >= 3) {
      suggestions.push({
        listingId: row.id,
        title: row.title,
        action: "refresh",
        reason: `Consider reviewing photos or title: ${row.favorites} favorites and no eligible paid sales. Verify order coverage first. ${evidence}`,
      });
      continue;
    }
    if (row.views >= 15) {
      suggestions.push({
        listingId: row.id,
        title: row.title,
        action: "refresh",
        reason: `Consider reviewing tags or mockups: ${row.views} views, ${row.favorites} favorites and no eligible paid sales. Verify order coverage first. ${evidence}`,
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

/** Paid shop totals for the trailing week; cancellations and unresolved refunds remain audit-only. */
export async function buildHealthReport(db: DB, shopId: string, now: Date): Promise<EvidenceHealthReport> {
  const window = weeklyWindow(now);

  const [realOrders, adRows, listingRows] = await Promise.all([
    db.select().from(orders).where(and(eq(orders.shopId, shopId), eq(orders.isDemo, false), notFakeReceiptWhere(), revenueEligibleOrderWhere())),
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

  const liveListings = listingRows.filter(isRealPublishedListing);
  const freshListings = liveListings.filter((listing) => hasFreshListingSnapshot(listing.analyticsCheckedAt, now));
  const views = liveListings.reduce((sum, listing) => sum + listing.views, 0);
  const favorites = liveListings.reduce((sum, listing) => sum + listing.favorites, 0);

  const suggestions = suggestListingActions(
    liveListings.map((listing) => {
      const opened = listing.publishedAt ?? listing.createdAt;
      return {
        id: listing.id,
        title: listing.title,
        views: listing.views,
        favorites: listing.favorites,
        sales: salesByListing.get(listing.id) ?? 0,
        ageDays: Math.floor((now.getTime() - opened.getTime()) / DAY_MS),
        analyticsCheckedAt: listing.analyticsCheckedAt,
      };
    }),
    now,
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
    recommendationEvidence: {
      version: 1,
      mode: "listing_snapshots",
      freshListings: freshListings.length,
      totalListings: liveListings.length,
      expiresAt: new Date(Math.min(
        now.getTime() + RECOMMENDATION_FRESHNESS_MS,
        ...freshListings.map((row) => row.analyticsCheckedAt!.getTime() + RECOMMENDATION_FRESHNESS_MS),
      )).toISOString(),
      humanApprovalRequired: true,
    },
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
        body: `${payload.views} view snapshots · ${payload.favorites} favorite snapshots · ${payload.sales} eligible paid weekly sales · estimated profit CHF ${payload.profitChf.toFixed(2)} after estimated fees. Estimated VAT CHF ${payload.vatChf.toFixed(2)}, POD CHF ${payload.podCostChf.toFixed(2)}, ad estimate CHF ${(payload.adsEstimateChf ?? payload.adsChf).toFixed(2)}, actual ads CHF ${(payload.adsActualChf ?? 0).toFixed(2)}. Review candidates: ${refresh} refresh, ${retire} retire. No changes applied.`,
        severity: "info",
        href: "/",
        shopId,
      },
      false,
    );
  }

  return { payload, pushed: inserted.length > 0 };
}
