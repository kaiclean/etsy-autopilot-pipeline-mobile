import { eq, sql } from "drizzle-orm";
import { MockLLMProvider } from "@/adapters/llm/mock";
import { isDemoMode } from "@/lib/config";
import { calculateFees, FEES, round2 } from "@/lib/fees";
import { dayKey } from "@/lib/format";
import { tryBuildFileManifest } from "@/lib/file-manifest";
import { isNichePaused, NICHE_LIST, scoreKeyword, seasonality } from "@/lib/niches";
import { buildPrompt } from "@/pipeline/design";
import { draftListing, pickProduct } from "@/pipeline/listing";
import { listingImageForProduct } from "@/pipeline/mockup";
import type { DB } from "./index";
import { costs, dailyStats, designs, events, jobRuns, keywords, listings, orders, type ListingStatus, type StageName } from "./schema";

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COUNTRIES = ["US", "US", "US", "US", "DE", "GB", "CH", "CA", "AU", "FR", "NL", "AT", "SE"];
const DAY = 864e5;

export async function seedIfEmpty(db: DB) {
  if (!isDemoMode()) return false;
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(keywords);
  if (n > 0) return false;
  await seedDemo(db);
  return true;
}

export async function clearDemo(db: DB) {
  await db.delete(orders).where(eq(orders.isDemo, true));
  await db.delete(listings).where(eq(listings.isDemo, true));
  await db.delete(designs).where(eq(designs.isDemo, true));
  await db.delete(keywords).where(eq(keywords.isDemo, true));
  await db.delete(costs).where(eq(costs.isDemo, true));
  await db.delete(dailyStats).where(eq(dailyStats.isDemo, true));
  await db.delete(jobRuns).where(eq(jobRuns.isDemo, true));
  await db.delete(events).where(eq(events.isDemo, true));
}

/** Clearly-labeled demo data (isDemo=true on every row) so the dashboard looks alive without keys. */
export async function seedDemo(db: DB, now = new Date()) {
  const rand = mulberry32(20260925);
  const llm = new MockLLMProvider();
  const ago = (days: number, hours = 0) => new Date(now.getTime() - days * DAY - hours * 36e5);

  // Keywords
  const kwRows = [];
  for (const n of NICHE_LIST) {
    for (const s of n.seeds) {
      const season = seasonality(n.id, now);
      kwRows.push({
        phrase: s.phrase,
        niche: n.id,
        source: "seed-list",
        demandScore: s.demand,
        competitionScore: s.competition,
        seasonalityScore: season,
        score: scoreKeyword({ demand: s.demand, competition: s.competition, seasonality: season }),
        status: n.pausedReason ? ("rejected" as const) : ("new" as const),
        isDemo: true,
        createdAt: ago(28),
      });
    }
  }
  const insertedKw = (await db.insert(keywords).values(kwRows).returning()).filter((kw) => !isNichePaused(kw.niche));

  // Designs + listings (30), across niches
  type Plan = { status: ListingStatus; publishedDaysAgo?: number };
  const plans: Plan[] = [
    ...Array.from({ length: 20 }, (_, i) => ({ status: "published" as const, publishedDaysAgo: 29 - Math.floor(i * 1.3) })),
    ...Array.from({ length: 6 }, () => ({ status: "pending_approval" as const })),
    { status: "approved" },
    { status: "approved" },
    { status: "rejected" },
    { status: "rejected" },
  ];
  const created: { id: number; productType: "digital" | "pod"; priceChf: number; podCostChf: number; publishedAt: Date | null; niche: string }[] = [];
  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i];
    const kw = insertedKw[i % insertedKw.length];
    const niche = NICHE_LIST.find((n) => n.id === kw.niche)!;
    const createdAt = plan.publishedDaysAgo != null ? ago(plan.publishedDaysAgo + 1) : ago(0, 2 + i);
    const [design] = await db
      .insert(designs)
      .values({
        keywordId: kw.id,
        niche: kw.niche,
        prompt: buildPrompt(kw.phrase, niche.style),
        provider: "mock",
        imageUrl: `/api/placeholder/${1000 + i}?niche=${kw.niche}&label=${encodeURIComponent(kw.phrase)}`,
        status: "listed",
        costChf: 0.05,
        isDemo: true,
        createdAt,
      })
      .returning();
    const product = pickProduct(kw.niche, rand());
    const { draft, fees, issues, pod } = await draftListing({
      niche: kw.niche,
      keyword: kw.phrase,
      product,
      seed: i,
      assumeOffsiteAds: false,
      llm,
    });
    let title = draft.title;
    let validation = issues;
    if (i === 21) {
      // One queue item intentionally over Etsy's title limit to demo inline fixing.
      title = `${draft.title} for Mountain Lovers, Cabin Decor, Housewarming Present and Minimalist Living Room`;
      const { validateListing } = await import("@/lib/listing-validator");
      validation = validateListing({ ...draft, title }).issues;
    }
    const publishedAt = plan.publishedDaysAgo != null ? ago(plan.publishedDaysAgo) : null;
    const ageDays = plan.publishedDaysAgo ?? 0;
    const views = publishedAt ? Math.floor(ageDays * (6 + rand() * 18)) : 0;
    const gallery = await listingImageForProduct({
      productType: product.type,
      artworkUrl: design.imageUrl,
      preset: product.pod,
      niche: kw.niche,
    });
    const deliveryUrl = product.type === "digital" ? design.imageUrl : null;
    const [listing] = await db
      .insert(listings)
      .values({
        designId: design.id,
        keywordId: kw.id,
        niche: kw.niche,
        productType: product.type,
        podProvider: product.type === "pod" ? `printify:${product.pod}` : null,
        title,
        tags: draft.tags,
        description: draft.description,
        imageUrl: gallery.url,
        deliveryUrl,
        fileManifest: deliveryUrl ? tryBuildFileManifest(deliveryUrl, gallery.url) : null,
        priceChf: draft.priceChf,
        podCostChf: pod,
        netChf: fees.netChf,
        marginPct: fees.marginPct,
        validation,
        status: plan.status,
        rejectedReason: plan.status === "rejected" ? "Too close to an existing bestseller's composition" : null,
        etsyListingId: publishedAt ? `demo-${4100000000 + i}` : null,
        printifyProductId: publishedAt && product.type === "pod" ? `demo-pfy-${i}` : null,
        publishMode: publishedAt ? "dry-run" : null,
        views,
        favorites: Math.floor(views * (0.03 + rand() * 0.05)),
        isDemo: true,
        createdAt,
        updatedAt: createdAt,
        approvedAt: publishedAt ?? (plan.status === "approved" ? ago(0, 1) : null),
        publishedAt,
      })
      .returning();
    await db.update(keywords).set({ status: "used" }).where(eq(keywords.id, kw.id));
    created.push({ id: listing.id, productType: product.type, priceChf: draft.priceChf, podCostChf: pod, publishedAt, niche: kw.niche });
    await db.insert(costs).values({ kind: "ai_image", amountChf: 0.05, note: "demo: image generation", isDemo: true, createdAt });
    if (publishedAt) {
      await db.insert(costs).values({
        kind: "listing_fee",
        amountChf: round2(FEES.listingFeeUsd * FEES.usdToChf * (1 + FEES.vatOnFeesRate)),
        note: "demo: listing fee",
        isDemo: true,
        createdAt: publishedAt,
      });
    }
  }

  // Orders: ~2/day rising over 30 days, only for listings already live on that day
  const published = created.filter((c) => c.publishedAt);
  const orderRows = [];
  for (let d = 29; d >= 0; d--) {
    const dayDate = ago(d);
    const live = published.filter((p) => p.publishedAt! <= dayDate);
    if (!live.length) continue;
    const expected = 0.4 + (29 - d) * 0.09;
    const count = Math.floor(expected + rand() * 1.6);
    for (let k = 0; k < count; k++) {
      const l = live[Math.floor(rand() * live.length)];
      const qty = rand() < 0.08 ? 2 : 1;
      const offsite = rand() < 0.12;
      const fees = calculateFees({ priceChf: l.priceChf, quantity: qty, podCostChf: l.podCostChf, offsiteAds: offsite });
      const createdAt = ago(d, Math.floor(rand() * 20) + (d === 0 ? 0 : 1));
      const status =
        l.productType === "digital" ? "delivered_digital" : d > 8 ? "delivered" : d > 4 ? "shipped" : d > 1 ? "in_production" : "pending";
      orderRows.push({
        etsyReceiptId: `demo-r-${d}-${k}-${l.id}`,
        listingId: l.id,
        buyerCountry: COUNTRIES[Math.floor(rand() * COUNTRIES.length)],
        quantity: qty,
        totalChf: fees.revenueChf,
        feesChf: fees.totalEtsyFeesChf,
        podCostChf: fees.podCostChf,
        offsiteAdsChf: fees.offsiteAdsFeeChf,
        profitChf: fees.netChf,
        fulfillmentStatus: status as "delivered_digital",
        podOrderId: l.productType === "pod" ? `demo-po-${d}-${k}` : null,
        isDemo: true,
        createdAt,
        updatedAt: createdAt,
      });
    }
  }
  if (orderRows.length) await db.insert(orders).values(orderRows);

  // Daily views
  const statRows = [];
  for (let d = 29; d >= 0; d--) {
    const views = Math.floor(35 + (29 - d) * 5.5 + rand() * 40);
    statRows.push({ date: dayKey(ago(d)), views, favorites: Math.floor(views * 0.05), isDemo: true });
  }
  await db.insert(dailyStats).values(statRows);

  // Ads budget (USD 1/day, last 20 days) and listing-copy costs
  const adRows = Array.from({ length: 20 }, (_, i) => ({
    kind: "ads_estimate" as const,
    amountChf: round2(1 * FEES.usdToChf),
    note: `Etsy Ads budget ${dayKey(ago(i))} (demo)`,
    isDemo: true,
    createdAt: ago(i),
  }));
  await db.insert(costs).values(adRows);

  // Recent job runs + activity feed
  const runSummaries: [string, string, number][] = [
    ["research", "Scored 24 keywords, selected 3, 0 left in backlog", 26],
    ["design", "Generated 6/6 designs · AI spend today CHF 0.30", 3],
    ["listing", "Drafted 6 listings for approval (1 needs fixes)", 2.5],
    ["publish", "Published 2, failed 0 (dry-run)", 1.7],
    ["orders", "2 new order(s), 1 fulfillment update(s)", 0.4],
    ["analytics", "30d: 58 orders, revenue CHF 1,084 · +112 views", 5],
    [
      "maintenance",
      '{"webhooks":{"existing":0,"created":0,"skipped":7,"reason":"demo mode"},"images":{"rewritten":0,"remaining":0,"reason":null},"fakeRows":{"orders":0,"costs":0,"daily_stats":0,"job_runs":0,"events":0,"reason":"demo mode"}}',
      0.2,
    ],
  ];
  for (const [stage, summary, hoursAgo] of runSummaries) {
    const startedAt = ago(0, hoursAgo);
    await db.insert(jobRuns).values({
      stage: stage as StageName,
      status: "success",
      trigger: "cron",
      summary,
      logs: [
        { t: startedAt.toISOString(), level: "info", msg: "Demo run (seeded)" },
        { t: startedAt.toISOString(), level: "info", msg: summary },
      ],
      isDemo: true,
      startedAt,
      finishedAt: new Date(startedAt.getTime() + 4200),
    });
  }
  const recentOrders = orderRows.filter((o) => o.createdAt > ago(1)).slice(-3);
  const feed = [
    { type: "listing.published", title: "2 listings published", body: "Dry-run: nothing was sent to Etsy/Printify", severity: "success" as const, href: "/products", createdAt: ago(0, 1.7) },
    { type: "approval.pending", title: "6 listings awaiting approval", body: "1 needs edits before it can be approved", severity: "warning" as const, href: "/queue", createdAt: ago(0, 2.5) },
    { type: "design.generated", title: "6 new designs generated", severity: "info" as const, href: "/pipeline", createdAt: ago(0, 3) },
    ...recentOrders.map((o) => ({
      type: "order.new",
      title: `New order · CHF ${o.totalChf.toFixed(2)}`,
      body: `Shipped to ${o.buyerCountry} · profit CHF ${o.profitChf.toFixed(2)}`,
      severity: "success" as const,
      href: "/orders",
      createdAt: o.createdAt,
    })),
  ].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  await db.insert(events).values(feed.map((f) => ({ ...f, isDemo: true })));
}
