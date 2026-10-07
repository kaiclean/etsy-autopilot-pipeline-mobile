import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { designBriefs, events, jobRuns, listings, orders, saleAlerts, shops } from "@/db/schema";
import { AI_DISCLOSURE, PRODUCTION_PARTNER_DISCLOSURE } from "@/lib/disclosures";
import { calculateFees } from "@/lib/fees";
import { evaluateQualityGate } from "@/lib/quality-gate";
import { claimSaleAlert, isRealSaleReceipt } from "@/lib/sale-alert";
import { getSetting } from "@/lib/settings";
import { saveReceipts } from "@/pipeline/orders";
import { flagStalledFulfillment, fulfillmentIsStalled, FULFILLMENT_STALL_MS } from "@/pipeline/fulfillment-watch";
import { buildHealthReport, publishHealthReport, suggestListingActions } from "@/pipeline/health-report";
import { runStage } from "@/pipeline/runner";

const tags = (words: string[]) => {
  const out = [...words];
  let n = 0;
  while (out.length < 13) {
    out.push(`tag ${n}`);
    n++;
  }
  return out.slice(0, 13);
};

function gateBase(overrides: Partial<Parameters<typeof evaluateQualityGate>[0]> = {}) {
  return {
    title: "Cozy Christmas Ceramic Mug",
    tags: tags(["holiday mug", "christmas gift"]),
    description: `${AI_DISCLOSURE}\n\n${PRODUCTION_PARTNER_DISCLOSURE}`,
    priceChf: 19.9,
    productType: "pod" as const,
    podProvider: "printify:mug",
    imageUrl: "/api/mockup/mug?niche=christmas",
    ...overrides,
  };
}

describe("quality gate", () => {
  it("accepts a mug with 13 short tags, a short title, disclosures, and a mockup", () => {
    const result = evaluateQualityGate(gateBase());
    expect(result.pass).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("holds mug copy on a poster, a poster price on a mug, and missing mockups or disclosures", () => {
    const mismatch = evaluateQualityGate(gateBase({ podProvider: "printify:posterA3", imageUrl: "/api/mockup/posterA3?niche=christmas", priceChf: 24.9 }));
    expect(mismatch.pass).toBe(false);
    expect(mismatch.reasons.map((reason) => reason.code)).toContain("variant_mismatch");

    const price = evaluateQualityGate(gateBase({ priceChf: 29.9 }));
    expect(price.reasons.map((reason) => reason.code)).toContain("price_mismatch");

    const mockup = evaluateQualityGate(gateBase({ imageUrl: "/api/placeholder/1" }));
    expect(mockup.reasons.map((reason) => reason.code)).toContain("missing_mockup");

    const disclosure = evaluateQualityGate(gateBase({ description: "No notes." }));
    expect(disclosure.reasons.map((reason) => reason.code)).toEqual(expect.arrayContaining(["missing_ai_disclosure", "missing_production_disclosure"]));

    const shape = evaluateQualityGate(gateBase({ title: "x".repeat(141), tags: tags(["this tag is way too long"]) }));
    expect(shape.reasons.map((reason) => reason.code)).toEqual(expect.arrayContaining(["title_too_long", "tag_too_long"]));
    expect(evaluateQualityGate(gateBase({ tags: ["only one"] })).reasons.map((reason) => reason.code)).toContain("tag_count");
  });

  it("requires the AI disclosure on digital downloads and allows poster wording", () => {
    const ok = evaluateQualityGate(
      gateBase({
        productType: "digital",
        podProvider: null,
        priceChf: 8.9,
        title: "Alpine Travel Poster Download",
        tags: tags(["travel poster", "alpine art"]),
        description: AI_DISCLOSURE,
        imageUrl: "/api/preview?niche=alpine",
      }),
    );
    expect(ok.pass).toBe(true);
    const missing = evaluateQualityGate(
      gateBase({
        productType: "digital",
        podProvider: null,
        description: "Just a file.",
        imageUrl: "/api/preview?niche=alpine",
        priceChf: 8.9,
      }),
    );
    expect(missing.reasons.map((reason) => reason.code)).toContain("missing_ai_disclosure");
    expect(missing.reasons.map((reason) => reason.code)).not.toContain("missing_production_disclosure");
  });
});

describe("refresh and retire suggestions", () => {
  it("retires quiet listings and refreshes ones with attention but no sales", () => {
    const suggestions = suggestListingActions([
      { id: 1, title: "Quiet", views: 2, favorites: 0, sales: 0, ageDays: 30 },
      { id: 2, title: "Watched", views: 40, favorites: 1, sales: 0, ageDays: 10 },
      { id: 3, title: "Loved", views: 8, favorites: 4, sales: 0, ageDays: 12 },
      { id: 4, title: "Seller", views: 1, favorites: 0, sales: 2, ageDays: 40 },
      { id: 5, title: "New", views: 0, favorites: 0, sales: 0, ageDays: 3 },
    ]);
    expect(suggestions.find((item) => item.listingId === 1)?.action).toBe("retire");
    expect(suggestions.find((item) => item.listingId === 2)?.action).toBe("refresh");
    expect(suggestions.find((item) => item.listingId === 3)?.action).toBe("refresh");
    expect(suggestions.find((item) => item.listingId === 4)).toBeUndefined();
    expect(suggestions.find((item) => item.listingId === 5)).toBeUndefined();
  });
});

async function memoryDb() {
  const client = new PGlite("memory://");
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  return db as unknown as DB;
}

async function omnishop(db: DB) {
  const [shop] = await db.select().from(shops).where(eq(shops.slug, "omnishop-ch"));
  if (!shop) throw new Error("omnishop missing");
  return shop;
}

describe("weekly health report", () => {
  it("sums real orders and skips demo and dry-run rows", async () => {
    const db = await memoryDb();
    const shop = await omnishop(db);
    const now = new Date("2026-10-05T09:00:00.000Z");
    const [listing] = await db
      .insert(listings)
      .values({
        shopId: shop.id,
        niche: "alpine",
        productType: "pod",
        podProvider: "printify:posterA3",
        title: "Matterhorn poster",
        tags: tags(["travel poster"]),
        description: "A poster",
        imageUrl: "/api/mockup/posterA3?niche=alpine",
        priceChf: 24.9,
        podCostChf: 12,
        netChf: 8,
        marginPct: 30,
        status: "published",
        publishMode: "live",
        etsyListingId: "445566",
        views: 40,
        favorites: 1,
        publishedAt: new Date("2026-09-01T00:00:00.000Z"),
        isDemo: false,
      })
      .returning();
    await db.insert(listings).values({
      shopId: shop.id,
      niche: "alpine",
      productType: "pod",
      podProvider: "printify:posterA3",
      title: "Quiet lake poster",
      tags: tags(["travel poster"]),
      description: "Another poster",
      imageUrl: "/api/mockup/posterA3?niche=alpine",
      priceChf: 24.9,
      podCostChf: 12,
      netChf: 8,
      marginPct: 30,
      status: "published",
      publishMode: "live",
      etsyListingId: "445567",
      views: 40,
      favorites: 1,
      publishedAt: new Date("2026-09-01T00:00:00.000Z"),
      isDemo: false,
    });
    await db.insert(orders).values({
      shopId: shop.id,
      etsyReceiptId: "9001",
      listingId: listing.id,
      buyerCountry: "CH",
      quantity: 1,
      totalChf: 24.9,
      feesChf: 4,
      podCostChf: 12,
      offsiteAdsChf: 0,
      profitChf: 8.5,
      fulfillmentStatus: "shipped",
      isDemo: false,
      createdAt: new Date("2026-10-03T12:00:00.000Z"),
    });
    await db.insert(orders).values({
      shopId: shop.id,
      etsyReceiptId: "dry-skip",
      listingId: listing.id,
      buyerCountry: "CH",
      quantity: 1,
      totalChf: 100,
      feesChf: 10,
      podCostChf: 50,
      profitChf: 40,
      fulfillmentStatus: "pending",
      isDemo: false,
      createdAt: new Date("2026-10-03T12:00:00.000Z"),
    });
    await db.insert(orders).values({
      shopId: shop.id,
      etsyReceiptId: "demo-skip",
      buyerCountry: "CH",
      quantity: 1,
      totalChf: 80,
      feesChf: 8,
      profitChf: 70,
      fulfillmentStatus: "pending",
      isDemo: true,
      createdAt: new Date("2026-10-03T12:00:00.000Z"),
    });
    await db.insert(schema.costs).values({ shopId: shop.id, kind: "ads", amountChf: 3.5, note: "real ads", isDemo: false, createdAt: new Date("2026-10-04T00:00:00.000Z") });
    await db.insert(schema.costs).values({ shopId: shop.id, kind: "ads", amountChf: 9, note: "demo ads", isDemo: true, createdAt: new Date("2026-10-04T00:00:00.000Z") });
    await db.insert(schema.dailyStats).values({ date: "2026-10-03", views: 11, favorites: 2, isDemo: false });
    await db.insert(schema.dailyStats).values({ date: "2026-10-03", views: 99, favorites: 9, isDemo: true });

    const report = await buildHealthReport(db, shop.id, now);
    const fees = calculateFees({ priceChf: 24.9, quantity: 1, podCostChf: 12, offsiteAds: false });
    expect(report.sales).toBe(1);
    expect(report.profitChf).toBe(8.5);
    expect(report.vatChf).toBe(fees.vatOnFeesChf);
    expect(report.podCostChf).toBe(12);
    expect(report.adsChf).toBe(3.5);
    expect(report.views).toBe(11);
    expect(report.favorites).toBe(2);
    expect(report.suggestions.map((item) => item.action)).toContain("refresh");

    const first = await publishHealthReport(db, shop.id, now);
    const second = await publishHealthReport(db, shop.id, now);
    expect(first.pushed).toBe(true);
    expect(second.pushed).toBe(false);
    const [eventCount] = await db.select({ n: sql<number>`count(*)::int` }).from(events).where(eq(events.type, "health.report"));
    expect(eventCount.n).toBe(1);
  });
});

describe("fulfillment watch and sale alerts", () => {
  const now = new Date("2026-10-07T12:00:00.000Z");

  it("flags only real Printify orders that have not moved for 48 hours, once", async () => {
    const db = await memoryDb();
    const shop = await omnishop(db);
    const old = new Date(now.getTime() - FULFILLMENT_STALL_MS - 60_000);
    const fresh = new Date(now.getTime() - FULFILLMENT_STALL_MS + 60_000);
    await db.insert(orders).values([
      {
        shopId: shop.id,
        etsyReceiptId: "9100",
        buyerCountry: "DE",
        totalChf: 24.9,
        feesChf: 4,
        podCostChf: 12,
        profitChf: 8,
        fulfillmentStatus: "in_production",
        podOrderId: "po-stalled",
        isDemo: false,
        fulfillmentChangedAt: old,
        createdAt: old,
      },
      {
        shopId: shop.id,
        etsyReceiptId: "9101",
        buyerCountry: "DE",
        totalChf: 19.9,
        feesChf: 3,
        podCostChf: 8,
        profitChf: 6,
        fulfillmentStatus: "pending",
        podOrderId: "po-fresh",
        isDemo: false,
        fulfillmentChangedAt: fresh,
        createdAt: fresh,
      },
      {
        shopId: shop.id,
        etsyReceiptId: "dry-9102",
        buyerCountry: "DE",
        totalChf: 19.9,
        feesChf: 3,
        profitChf: 6,
        fulfillmentStatus: "pending",
        podOrderId: "dry-po-9102",
        isDemo: false,
        fulfillmentChangedAt: old,
        createdAt: old,
      },
    ]);
    expect(
      fulfillmentIsStalled({
        podOrderId: "po-stalled",
        fulfillmentStatus: "in_production",
        changedAt: old,
        createdAt: old,
        isDemo: false,
        etsyReceiptId: "9100",
        now,
      }),
    ).toBe(true);
    const first = await flagStalledFulfillment(db, { shopId: shop.id, now });
    const second = await flagStalledFulfillment(db, { shopId: shop.id, now });
    expect(first.flagged).toBe(1);
    expect(second.flagged).toBe(0);
    const rows = await db.select().from(orders);
    expect(rows.find((row) => row.etsyReceiptId === "9100")?.fulfillmentStalledAt).toBeTruthy();
    expect(rows.find((row) => row.etsyReceiptId === "9101")?.fulfillmentStalledAt).toBeNull();
    expect(rows.find((row) => row.etsyReceiptId === "dry-9102")?.fulfillmentStalledAt).toBeNull();
    const [pushes] = await db.select({ n: sql<number>`count(*)::int` }).from(events).where(eq(events.type, "fulfillment.stalled"));
    expect(pushes.n).toBe(1);
  });

  it("pushes a real sale once and stays quiet for dry-run receipts", async () => {
    const db = await memoryDb();
    const shop = await omnishop(db);
    const [listing] = await db
      .insert(listings)
      .values({
        shopId: shop.id,
        niche: "christmas",
        productType: "pod",
        title: "Holiday mug",
        tags: ["mug"],
        description: "Mug",
        imageUrl: "/api/mockup/mug?niche=christmas",
        priceChf: 19.9,
        podCostChf: 8,
        netChf: 6,
        marginPct: 30,
        status: "published",
        etsyListingId: "556677",
        isDemo: false,
      })
      .returning();
    const receipt = {
      receiptId: "9200",
      etsyListingId: "556677",
      buyerCountry: "CH",
      quantity: 1,
      totalChf: 19.9,
      createdAt: now,
    };
    const byId = new Map([[listing.etsyListingId!, listing]]);
    await saveReceipts(db, [receipt], byId, { shopId: shop.id, isDemo: false, offsite: () => false });
    await saveReceipts(db, [receipt], byId, { shopId: shop.id, isDemo: false, offsite: () => false });
    await saveReceipts(
      db,
      [{ ...receipt, receiptId: "dry-1", etsyListingId: "556677" }],
      byId,
      { shopId: shop.id, isDemo: true, offsite: () => false },
    );
    const alerts = await db.select().from(saleAlerts);
    expect(alerts.map((row) => row.etsyReceiptId)).toEqual(["9200"]);
    expect(await claimSaleAlert(db, "9200", shop.id)).toBe(false);
    expect(isRealSaleReceipt("dry-1", true)).toBe(false);
    expect(isRealSaleReceipt("9200", false)).toBe(true);
    const saleEvents = await db.select().from(events).where(eq(events.type, "order.new"));
    expect(saleEvents.filter((event) => !event.isDemo)).toHaveLength(1);
    expect(saleEvents.filter((event) => event.isDemo)).toHaveLength(1);
  });
});

describe("daily chain", () => {
  const trends = process.env.RESEARCH_GOOGLE_TRENDS;
  afterEach(() => {
    if (trends === undefined) delete process.env.RESEARCH_GOOGLE_TRENDS;
    else process.env.RESEARCH_GOOGLE_TRENDS = trends;
  });

  it("drafts pending listings once and does not publish or change go-live", async () => {
    process.env.RESEARCH_GOOGLE_TRENDS = "false";
    const db = await memoryDb();
    const before = await getSetting(db, "automation");
    expect(before.publishMode).toBe("dry-run");
    const now = new Date();
    const first = await runStage("daily", "cron", { db, now, random: () => 0.1 });
    expect(first.status).toBe("success");
    expect(first.summary).toMatch(/pending approval|quality gate/i);
    expect(first.summary).toMatch(/Nothing was activated/);

    const drafts = await db.select().from(listings);
    expect(drafts.length).toBeGreaterThan(0);
    for (const draft of drafts) {
      expect(["pending_approval", "quality_failed"]).toContain(draft.status);
      expect(draft.activatedAt).toBeNull();
      expect(draft.publishMode).toBeNull();
      expect(draft.etsyListingId).toBeNull();
    }
    const queued = drafts.filter((draft) => draft.status === "pending_approval");
    expect(queued.length).toBeGreaterThan(0);
    const briefs = await db.select().from(designBriefs);
    expect(briefs.length).toBeGreaterThan(0);

    const publishes = await db.select().from(jobRuns).where(eq(jobRuns.stage, "publish"));
    expect(publishes).toHaveLength(0);
    const after = await getSetting(db, "automation");
    expect(after.publishMode).toBe("dry-run");

    const second = await runStage("daily", "cron", { db, now, random: () => 0.9 });
    expect(second.status).toBe("success");
    expect(second.summary).toMatch(/already completed/);
    const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(listings);
    expect(count.n).toBe(drafts.length);
  }, 60_000);
});
