import { and, asc, count, desc, eq, gte, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { costs, dailyStats, events, jobRuns, keywords, listings, orders, printifyEvents, type JobRun, type StageName } from "@/db/schema";
import { STAGES } from "@/pipeline/types";
import { config, hasEtsyCredentials, hasPrintifyCredentials, isDemoMode } from "./config";
import { printifyEventLog } from "./ops-copy";
import { connectionHealth } from "./health";
import { dryRunNotice } from "./operator-mode";
import { effectivePublishMode } from "./publish-mode";
import { setupPresence } from "./setup-guide";
import { visible } from "./events";
import { dayKey } from "./format";
import { NICHES } from "./niches";
import { buildCockpitAlerts, countListingsMissingEtsyId, loadCronRunFacts, railwayDeploySha } from "./alerts";
import { buildShopIdentity } from "./shop-identity";
import { getSetting } from "./settings";

const DAY = 864e5;

function lastNDays(n: number, now = new Date()) {
  return Array.from({ length: n }, (_, i) => dayKey(new Date(now.getTime() - (n - 1 - i) * DAY)));
}

export async function getShellData() {
  const db = await getDb();
  const [pending, automation] = await Promise.all([
    db.select({ id: listings.id }).from(listings).where(and(eq(listings.status, "pending_approval"), visible(listings.isDemo))),
    getSetting(db, "automation"),
  ]);
  const demo = isDemoMode();
  const publishMode = effectivePublishMode(automation.publishMode);
  return {
    pendingCount: pending.length,
    demo,
    killSwitch: automation.killSwitch,
    publishMode,
    dryRunNotice: dryRunNotice({ publishMode, demo }),
    identity: buildShopIdentity({ publishMode, killSwitch: automation.killSwitch }),
  };
}

export async function getCockpitAlerts() {
  const db = await getDb();
  const [tokens, automation, catalogDraft, cronRuns, nullEtsyIdCount] = await Promise.all([
    getSetting(db, "etsyTokens"),
    getSetting(db, "automation"),
    getSetting(db, "catalogDraft"),
    loadCronRunFacts(db),
    countListingsMissingEtsyId(db),
  ]);
  return buildCockpitAlerts({
    cronRuns,
    nullEtsyIdCount,
    deploySha: railwayDeploySha(),
    tokens,
    killSwitch: automation.killSwitch,
    catalogDraftPending: catalogDraft.pending && !catalogDraft.reviewedByKai,
  });
}

type RangeKey = "today" | "7d" | "30d";

async function loadWindow(days: number) {
  const db = await getDb();
  const since = new Date(Date.now() - days * DAY);
  const [o, c, s] = await Promise.all([
    db.select().from(orders).where(and(gte(orders.createdAt, since), visible(orders.isDemo))),
    db.select().from(costs).where(and(gte(costs.createdAt, since), visible(costs.isDemo))),
    db.select().from(dailyStats).where(visible(dailyStats.isDemo)),
  ]);
  return { orders: o, costs: c, stats: s };
}

export async function getHomeData() {
  const db = await getDb();
  const { orders: o, costs: c, stats } = await loadWindow(60);
  const now = new Date();
  const todayKey = dayKey(now);
  const days60 = lastNDays(60, now);

  const byDay = new Map<string, { revenue: number; profit: number; orders: number; costs: number; views: number }>();
  for (const k of days60) byDay.set(k, { revenue: 0, profit: 0, orders: 0, costs: 0, views: 0 });
  for (const x of o) {
    const b = byDay.get(dayKey(x.createdAt));
    if (b) {
      b.revenue += x.totalChf;
      b.profit += x.profitChf;
      b.orders += 1;
    }
  }
  for (const x of c) {
    const b = byDay.get(dayKey(x.createdAt));
    if (b && x.kind !== "listing_fee") b.costs += x.amountChf;
  }
  for (const s of stats) {
    const b = byDay.get(s.date);
    if (b) b.views += s.views;
  }

  const sum = (keys: string[]) => {
    const t = { revenue: 0, profit: 0, orders: 0, costs: 0, views: 0 };
    for (const k of keys) {
      const b = byDay.get(k)!;
      t.revenue += b.revenue;
      t.profit += b.profit;
      t.orders += b.orders;
      t.costs += b.costs;
      t.views += b.views;
    }
    return { ...t, net: t.profit - t.costs, conversion: t.views ? (t.orders / t.views) * 100 : 0 };
  };
  const windows: Record<RangeKey, number> = { today: 1, "7d": 7, "30d": 30 };
  const kpis = Object.fromEntries(
    (Object.keys(windows) as RangeKey[]).map((r) => {
      const n = windows[r];
      const cur = sum(days60.slice(-n));
      const prev = sum(days60.slice(-2 * n, -n));
      return [r, { cur, prev }];
    }),
  ) as Record<RangeKey, { cur: ReturnType<typeof sum>; prev: ReturnType<typeof sum> }>;

  const series = days60.slice(-30).map((k) => ({ date: k, ...byDay.get(k)! }));

  const [lastRuns, feed, pending, liveCount] = await Promise.all([
    getLastRuns(),
    db.select().from(events).where(visible(events.isDemo)).orderBy(desc(events.id)).limit(20),
    db.select().from(listings).where(and(eq(listings.status, "pending_approval"), visible(listings.isDemo))).orderBy(asc(listings.createdAt)),
    db.select({ id: listings.id }).from(listings).where(and(eq(listings.status, "published"), visible(listings.isDemo))),
  ]);
  const automation = await getSetting(db, "automation");

  return { kpis, series, lastRuns, feed, pending: pending.slice(0, 3), pendingCount: pending.length, liveListings: liveCount.length, todayKey, killSwitch: automation.killSwitch };
}

export async function getLastRuns() {
  const db = await getDb();
  const runs = await db.select().from(jobRuns).where(visible(jobRuns.isDemo)).orderBy(desc(jobRuns.id)).limit(200);
  const last: Partial<Record<StageName, JobRun>> = {};
  for (const r of runs) if (!last[r.stage]) last[r.stage] = r;
  return STAGES.map((s) => ({ ...s, run: last[s.id] ?? null }));
}

export async function getPipelineData() {
  const db = await getDb();
  const [runs, stageSettings, automation, kw] = await Promise.all([
    db.select().from(jobRuns).where(visible(jobRuns.isDemo)).orderBy(desc(jobRuns.id)).limit(300),
    getSetting(db, "stages"),
    getSetting(db, "automation"),
    db
      .select()
      .from(keywords)
      .where(and(inArray(keywords.status, ["new", "selected"]), visible(keywords.isDemo)))
      .orderBy(desc(keywords.score))
      .limit(12),
  ]);
  const byStage = STAGES.map((s) => ({
    ...s,
    settings: stageSettings[s.id],
    runs: runs.filter((r) => r.stage === s.id).slice(0, 8),
  }));
  return { stages: byStage, automation, keywords: kw };
}

export async function getQueue() {
  const db = await getDb();
  return db
    .select()
    .from(listings)
    .where(and(eq(listings.status, "pending_approval"), visible(listings.isDemo)))
    .orderBy(asc(listings.createdAt));
}

export async function getListings() {
  const db = await getDb();
  return db.select().from(listings).where(visible(listings.isDemo)).orderBy(desc(listings.updatedAt));
}

export async function getOrders() {
  const db = await getDb();
  const rows = await db
    .select({ order: orders, title: listings.title, imageUrl: listings.imageUrl, productType: listings.productType, niche: listings.niche })
    .from(orders)
    .leftJoin(listings, eq(orders.listingId, listings.id))
    .where(visible(orders.isDemo))
    .orderBy(desc(orders.createdAt))
    .limit(300);
  const since = Date.now() - 30 * DAY;
  const recent = rows.filter((r) => r.order.createdAt.getTime() >= since);
  const summary = {
    count30d: recent.length,
    revenue30d: recent.reduce((s, r) => s + r.order.totalChf, 0),
    profit30d: recent.reduce((s, r) => s + r.order.profitChf, 0),
    openPod: rows.filter((r) => ["pending", "in_production", "shipped"].includes(r.order.fulfillmentStatus)).length,
  };
  return { rows, summary };
}

export async function getAnalytics() {
  const db = await getDb();
  const { orders: o, costs: c, stats } = await loadWindow(30);
  const allListings = await db.select().from(listings).where(visible(listings.isDemo));
  const listingById = new Map(allListings.map((l) => [l.id, l]));
  const days = lastNDays(30);

  const series = days.map((date) => ({ date, revenue: 0, profit: 0, orders: 0, views: 0, favorites: 0 }));
  const idx = new Map(days.map((d, i) => [d, i]));
  for (const x of o) {
    const i = idx.get(dayKey(x.createdAt));
    if (i != null) {
      series[i].revenue += x.totalChf;
      series[i].profit += x.profitChf;
      series[i].orders += 1;
    }
  }
  for (const s of stats) {
    const i = idx.get(s.date);
    if (i != null) {
      series[i].views += s.views;
      series[i].favorites += s.favorites;
    }
  }

  const niches = Object.values(NICHES).map((n) => ({ id: n.id, label: n.short, revenue: 0, profit: 0, orders: 0, listings: 0, views: 0 }));
  const nicheIdx = new Map(niches.map((n, i) => [n.id, i]));
  for (const l of allListings) {
    if (l.status !== "published") continue;
    const n = niches[nicheIdx.get(l.niche)!];
    n.listings += 1;
    n.views += l.views;
  }
  const products = new Map<number, { id: number; title: string; imageUrl: string; niche: string; orders: number; revenue: number; profit: number; views: number }>();
  let fees = 0;
  let pod = 0;
  let offsite = 0;
  for (const x of o) {
    fees += x.feesChf - x.offsiteAdsChf;
    offsite += x.offsiteAdsChf;
    pod += x.podCostChf;
    const l = x.listingId ? listingById.get(x.listingId) : undefined;
    if (!l) continue;
    const n = niches[nicheIdx.get(l.niche)!];
    n.revenue += x.totalChf;
    n.profit += x.profitChf;
    n.orders += 1;
    const p = products.get(l.id) ?? { id: l.id, title: l.title, imageUrl: l.imageUrl, niche: l.niche, orders: 0, revenue: 0, profit: 0, views: l.views };
    p.orders += 1;
    p.revenue += x.totalChf;
    p.profit += x.profitChf;
    products.set(l.id, p);
  }
  const costByKind = { ai_image: 0, ai_text: 0, ads: 0, listing_fee: 0, other: 0 };
  for (const x of c) costByKind[x.kind] += x.amountChf;

  const revenue = o.reduce((s, x) => s + x.totalChf, 0);
  const profitAfterFees = o.reduce((s, x) => s + x.profitChf, 0);
  const views = series.reduce((s, x) => s + x.views, 0);
  const favorites = stats.filter((s) => idx.has(s.date)).reduce((s, x) => s + x.favorites, 0);
  const operatingCosts = costByKind.ai_image + costByKind.ai_text + costByKind.ads + costByKind.other;

  return {
    series,
    niches,
    topProducts: [...products.values()].sort((a, b) => b.profit - a.profit).slice(0, 8),
    costByKind,
    totals: {
      revenue,
      profitAfterFees,
      netProfit: profitAfterFees - operatingCosts,
      etsyFees: fees,
      offsiteAds: offsite,
      podCosts: pod,
      operatingCosts,
      orders: o.length,
      views,
      favorites,
      conversion: views ? (o.length / views) * 100 : 0,
      aov: o.length ? revenue / o.length : 0,
    },
  };
}

export async function getConnectionsData() {
  const db = await getDb();
  const [tokens, automation, stages, lastRuns, eventCount, recentEvents] = await Promise.all([
    getSetting(db, "etsyTokens"),
    getSetting(db, "automation"),
    getSetting(db, "stages"),
    getLastRuns(),
    db.select({ total: count() }).from(printifyEvents),
    db
      .select({
        id: printifyEvents.id,
        eventId: printifyEvents.eventId,
        topic: printifyEvents.topic,
        createdAt: printifyEvents.createdAt,
        verified: printifyEvents.verified,
      })
      .from(printifyEvents)
      .orderBy(desc(printifyEvents.id))
      .limit(8),
  ]);
  const etsyConnected = Boolean(tokens?.accessToken);
  const accessExpired = Boolean(tokens?.expiresAt && Date.now() > tokens.expiresAt);
  const publishMode = effectivePublishMode(automation.publishMode);
  return {
    checks: connectionHealth({ etsyConnected, publishMode, accessExpired }),
    etsyConnected,
    canConnectEtsy: Boolean(config.etsy.apiKey),
    etsyKeysReady: hasEtsyCredentials(),
    printifyConfigured: hasPrintifyCredentials(),
    webhookSecretSet: Boolean(config.printify.webhookSecret),
    printifyEventCount: Number(eventCount[0]?.total ?? 0),
    printifyEvents: printifyEventLog(recentEvents),
    stages,
    lastRuns,
    killSwitch: automation.killSwitch,
    publishMode,
    envPublishMode: config.publishMode,
    demo: isDemoMode(),
    presence: setupPresence(),
  };
}

export async function getSettingsData() {
  const db = await getDb();
  const [automation, stages, pushPrefs, connections] = await Promise.all([
    getSetting(db, "automation"),
    getSetting(db, "stages"),
    getSetting(db, "pushPrefs"),
    getConnectionsData(),
  ]);
  return { ...connections, automation, stages, pushPrefs };
}
