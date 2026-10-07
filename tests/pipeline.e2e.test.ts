import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { getDb, type DB } from "@/db";
import { designs, events, keywords, listings, orders } from "@/db/schema";
import { PRINT_SPECS } from "@/lib/deliverables";
import { alignDeliveryCopy } from "@/lib/delivery";
import { withDisclosures } from "@/lib/disclosures";
import { validateListing } from "@/lib/listing-validator";
import { getSetting, setSetting } from "@/lib/settings";
import { getAnalytics } from "@/lib/queries";
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
    expect(pendingAfter).toBeGreaterThan(pendingBefore);

    const fresh = await db.select().from(listings).where(eq(listings.status, "pending_approval"));
    for (const x of fresh.slice(-3)) {
      expect(x.title.length).toBeLessThanOrEqual(140);
      expect(x.tags).toHaveLength(13);
      expect(x.description).toContain("AI image tools");
      expect(x.netChf).toBeGreaterThan(0);
    }
  });

  it("produce renders a 300 DPI print pack for wall-art downloads, once, and publish ships it", async () => {
    const prevScale = process.env.PRODUCE_SCALE;
    process.env.PRODUCE_SCALE = "0.05";
    try {
      const [design] = await db.select().from(designs).limit(1);
      const [src] = await db.select().from(listings).limit(1);
      const [row] = await db
        .insert(listings)
        .values({
          designId: design.id,
          keywordId: design.keywordId,
          niche: "alpine",
          productType: "digital",
          title: "Minimal Swiss Alps Wall Art Printable Mountain Poster",
          tags: Array.from({ length: 13 }, (_, i) => `swiss alps art ${i}`),
          description: withDisclosures(alignDeliveryCopy("A calm alpine scene in muted tones.", "digital"), "digital"),
          imageUrl: design.imageUrl,
          priceChf: 8,
          podCostChf: 0,
          netChf: src.netChf,
          marginPct: src.marginPct,
          validation: [],
          status: "pending_approval",
          isDemo: true,
        })
        .returning();

      const r = await runStage("produce", "manual", { db, random });
      expect(r.status).toBe("success");
      const [made] = await db.select().from(listings).where(eq(listings.id, row.id));
      expect(made.deliverables.map((d) => d.ratio)).toEqual(["2:3", "3:4", "4:5", "11x14", "ISO A"]);
      expect(made.deliverables.every((d) => d.stored === false && d.url.startsWith("dry-run://"))).toBe(true);
      expect(made.description).toContain("5 high-resolution JPG files (300 DPI)");
      expect(made.description).not.toContain("One PNG");
      expect(made.validation.map((i) => i.code)).toContain("files_not_stored");
      // Preview-scale files are smaller than the 300 DPI sizes the copy now promises: the gate must refuse them.
      expect(made.validation.map((i) => i.code)).toContain("delivery_mismatch");

      const again = await runStage("produce", "manual", { db, random });
      expect(again.status).toBe("success");
      const [same] = await db.select().from(listings).where(eq(listings.id, row.id));
      expect(same.deliverables).toEqual(made.deliverables);

      await db.update(listings).set({ status: "approved", approvedAt: new Date() }).where(eq(listings.id, row.id));
      const blocked = await runStage("publish", "manual", { db, random });
      expect(blocked.status).toBe("failed");
      const [back] = await db.select().from(listings).where(eq(listings.id, row.id));
      expect(back.status).toBe("pending_approval");

      // A full-size run (≈15 s per listing, covered by the renderer tests) records spec-sized files.
      const full = made.deliverables.map((d) => {
        const spec = PRINT_SPECS.find((s) => s.ratio === d.ratio)!;
        return { ...d, width: spec.width, height: spec.height, upscale: 3.9 };
      });
      await db.update(listings).set({ deliverables: full, status: "approved", approvedAt: new Date() }).where(eq(listings.id, row.id));
      const p = await runStage("publish", "manual", { db, random });
      expect(p.status).toBe("success");
      const [published] = await db.select().from(listings).where(eq(listings.id, row.id));
      expect(published.status).toBe("published");
      expect(published.publishMode).toBe("dry-run");
    } finally {
      if (prevScale === undefined) delete process.env.PRODUCE_SCALE;
      else process.env.PRODUCE_SCALE = prevScale;
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
    expect(published.status).toBe("published");
    expect(published.publishMode).toBe("dry-run");
    expect(published.etsyListingId).toMatch(/^dry-/);

    const ordersBefore = await count(db, orders);
    const o = await runStage("orders", "manual", { db, random });
    expect(o.status).toBe("success");
    expect(await count(db, orders)).toBeGreaterThan(ordersBefore);
    const orderEvents = await db.select().from(events).where(eq(events.type, "order.new"));
    expect(orderEvents.length).toBeGreaterThan(0);

    const a = await runStage("analytics", "manual", { db, random });
    expect(a.status).toBe("success");
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
