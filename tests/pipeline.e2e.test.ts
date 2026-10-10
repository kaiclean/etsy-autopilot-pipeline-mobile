import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { getDb, type DB } from "@/db";
import { designs, events, keywords, listings, orders } from "@/db/schema";
import { validateListing } from "@/lib/listing-validator";
import { getSetting, setSetting } from "@/lib/settings";
import { getAnalytics } from "@/lib/queries";
import { publishPodListingToEtsy, recordPodSample } from "@/pipeline/human-publish";
import { runStage } from "@/pipeline/runner";

function seeded(seed: number) {
  let a = seed;
  return () => {
    a = (a * 1664525 + 1013904223) % 4294967296;
    return a / 4294967296;
  };
}

const count = async (db: DB, table: typeof listings | typeof orders | typeof designs, where?: ReturnType<typeof eq>) =>
  (await db.select({ n: sql<number>`count(*)::int` }).from(table).where(where))[0].n;

describe("mock pipeline end to end (PGlite in-memory, dry-run adapters)", () => {
  let db: DB;
  const random = seeded(42);

  beforeAll(async () => {
    db = await getDb();
  });

  it("seeds labeled demo data", async () => {
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(listings).where(eq(listings.isDemo, true));
    expect(n).toBeGreaterThan(20);
  });

  it("research → design → listing produces new items awaiting approval", async () => {
    const pendingBefore = await count(db, listings, eq(listings.status, "pending_approval"));

    const r = await runStage("research", "manual", { db, random });
    expect(r.status).toBe("success");
    const [{ selected }] = await db.select({ selected: sql<number>`count(*)::int` }).from(keywords).where(eq(keywords.status, "selected"));
    expect(selected).toBeGreaterThan(0);

    const d = await runStage("design", "manual", { db, random });
    expect(d.status).toBe("success");
    expect(await count(db, designs, eq(designs.status, "generated"))).toBeGreaterThan(0);

    const l = await runStage("listing", "manual", { db, random });
    expect(l.status).toBe("success");
    const pendingAfter = await count(db, listings, eq(listings.status, "pending_approval"));
    expect(pendingAfter).toBe(pendingBefore);
    const held = await db.select().from(listings).where(eq(listings.status, "quality_failed"));
    expect(held.length).toBeGreaterThan(0);
    expect(held.some((row) => row.validation.some((issue) => issue.code === "placeholder_art"))).toBe(true);
    for (const x of held.slice(-3)) {
      expect(x.title.length).toBeLessThanOrEqual(140);
      expect(x.tags).toHaveLength(13);
      expect(x.description).toContain("AI image tools");
      expect(x.netChf).toBeGreaterThan(0);
    }
  });

  it("approve → dry-run publish → fake order → analytics update", async () => {
    const pending = await db.select().from(listings).where(eq(listings.status, "pending_approval"));
    const target = pending.find((p) => validateListing(p).valid)!;
    expect(target).toBeDefined();
    await db.update(listings).set({ status: "approved", approvedAt: new Date() }).where(eq(listings.id, target.id));

    const before = await getAnalytics();

    const p = await runStage("publish", "manual", { db, random });
    expect(p.status).toBe("success");
    expect(p.summary).toContain("dry-run");
    const [published] = await db.select().from(listings).where(eq(listings.id, target.id));
    expect(published.publishMode).toBe("dry-run");
    if (published.productType === "pod") {
      expect(published.status).toBe("pod_created");
      expect(published.etsyListingId).toBeNull();
      expect(published.podBlueprintId).toBeTruthy();
      await recordPodSample(db, {
        blueprintId: published.podBlueprintId!,
        providerId: published.podPrintProviderId!,
        actor: "kai",
        note: "sample",
      });
      const sent = await publishPodListingToEtsy(db, published.id);
      expect(sent.ok).toBe(true);
    } else {
      expect(published.status).toBe("published");
      expect(published.activatedAt).toBeNull();
      expect(published.etsyListingId).toMatch(/^dry-/);
      expect(published.imageUrl).not.toBe(published.deliveryUrl);
    }
    const [afterPublish] = await db.select().from(listings).where(eq(listings.id, target.id));
    expect(afterPublish.status).toBe("published");
    expect(afterPublish.etsyListingId).toMatch(/^dry-/);

    const ordersBefore = await count(db, orders);
    const o = await runStage("orders", "manual", { db, random });
    expect(o.status).toBe("success");
    expect(await count(db, orders)).toBeGreaterThan(ordersBefore);
    const orderEvents = await db.select().from(events).where(eq(events.type, "order.new"));
    expect(orderEvents.length).toBeGreaterThan(0);

    const a = await runStage("analytics", "manual", { db, random });
    expect(a.status).toBe("success");
    const [syncedListing] = await db.select().from(listings).where(eq(listings.id, target.id));
    expect(syncedListing.analyticsCheckedAt).toBeInstanceOf(Date);
    const after = await getAnalytics();
    expect(after.totals.orders).toBeGreaterThan(before.totals.orders);
    expect(after.totals.revenue).toBeGreaterThan(before.totals.revenue);
  });

  it("kill switch blocks every stage", async () => {
    const auto = await getSetting(db, "automation");
    await setSetting(db, "automation", { ...auto, killSwitch: true });
    const r = await runStage("design", "manual", { db, random });
    expect(r.status).toBe("skipped");
    expect(r.summary).toMatch(/Kill switch/);
    await setSetting(db, "automation", { ...auto, killSwitch: false });
  });

  it("paused stages skip cron runs but allow manual runs", async () => {
    const stages = await getSetting(db, "stages");
    await setSetting(db, "stages", { ...stages, analytics: { ...stages.analytics, paused: true } });
    expect((await runStage("analytics", "cron", { db, random })).status).toBe("skipped");
    expect((await runStage("analytics", "manual", { db, random })).status).toBe("success");
    await setSetting(db, "stages", stages);
  });

  it("a publish run that publishes nothing is failed, not success", async () => {
    const [src] = await db.select().from(listings).limit(1);
    const [row] = await db
      .insert(listings)
      .values({
        designId: src.designId,
        keywordId: src.keywordId,
        niche: src.niche,
        productType: src.productType,
        podProvider: src.podProvider,
        title: "",
        tags: src.tags,
        description: src.description,
        imageUrl: src.imageUrl,
        priceChf: src.priceChf,
        podCostChf: src.podCostChf,
        netChf: src.netChf,
        marginPct: src.marginPct,
        validation: [],
        status: "approved",
        isDemo: true,
      })
      .returning();

    const p = await runStage("publish", "manual", { db, random });
    expect(p.status).toBe("failed");
    expect(p.summary).toMatch(/Published 0, failed/);
    const [after] = await db.select().from(listings).where(eq(listings.id, row.id));
    expect(after.status).toBe("pending_approval");
  });

  it("daily AI cap stops paid image generation", async () => {
    const prev = process.env.IMAGE_PROVIDER;
    const prevKey = process.env.OPENAI_API_KEY;
    process.env.IMAGE_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-test-not-used";
    const auto = await getSetting(db, "automation");
    await setSetting(db, "automation", { ...auto, dailyAiCapChf: 0 });
    await runStage("research", "manual", { db, random });
    const r = await runStage("design", "manual", { db, random });
    expect(r.logs.some((l) => l.msg.includes("Daily AI cap reached"))).toBe(true);
    await setSetting(db, "automation", auto);
    process.env.IMAGE_PROVIDER = prev;
    process.env.OPENAI_API_KEY = prevKey;
  });
});
