import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { getPinterestAdapter } from "@/adapters/pinterest";
import { PinterestDryRunAdapter } from "@/adapters/pinterest/dryrun";
import type { PinInput, PinterestAdapter } from "@/adapters/pinterest/types";
import { getDb, type DB } from "@/db";
import { listings, promotions } from "@/db/schema";
import { AI_DISCLOSURE } from "@/lib/disclosures";
import { buildPinCopy, etsyListingUrl, PIN_LIMITS } from "@/lib/pin-copy";
import { claimPromotion, makeRunPromote, MAX_PIN_ATTEMPTS } from "@/pipeline/promote";
import type { StageContext } from "@/pipeline/types";

describe("pin copy", () => {
  it("fits Pinterest limits, cuts on word boundaries and links the Etsy listing", () => {
    const long = "Minimalist Swiss Alps Wall Art Printable Matterhorn Poster Alpine Lake Gallery Wall Set Muted Earthy Mountain Print Download";
    const copy = buildPinCopy({
      title: long,
      description: `A calm alpine scene in muted earthy tones. ${"Soft grain. ".repeat(80)}\n\nWHAT YOU GET\n• 5 files\n\n${AI_DISCLOSURE}`,
      etsyListingId: "1234567890",
    });
    expect(copy.title.length).toBeLessThanOrEqual(PIN_LIMITS.title);
    expect(long.startsWith(copy.title)).toBe(true);
    expect(copy.title.endsWith(" ")).toBe(false);
    expect(copy.description.length).toBeLessThanOrEqual(PIN_LIMITS.description);
    expect(copy.description).not.toContain("WHAT YOU GET");
    expect(copy.description).toContain("AI");
    expect(copy.altText.length).toBeLessThanOrEqual(PIN_LIMITS.altText);
    expect(copy.link).toBe("https://www.etsy.com/listing/1234567890");
    expect(etsyListingUrl("42")).toBe("https://www.etsy.com/listing/42");
  });
});

class FailingAdapter implements PinterestAdapter {
  readonly mode = "dry-run" as const;
  calls = 0;
  async createPin(): Promise<{ pinId: string }> {
    this.calls++;
    throw new Error("Pinterest 429: rate limited");
  }
}

class LiveRecorder implements PinterestAdapter {
  readonly mode = "live" as const;
  pins: PinInput[] = [];
  async createPin(input: PinInput) {
    this.pins.push(input);
    return { pinId: `live-${this.pins.length}` };
  }
}

describe("promote stage", () => {
  let db: DB;
  const ctx = (): StageContext => ({ db, trigger: "manual", random: Math.random, now: new Date(), log: () => {} });

  beforeAll(async () => {
    db = await getDb();
  });

  async function published(over: Partial<typeof listings.$inferInsert> = {}) {
    const [src] = await db.select().from(listings).limit(1);
    const [row] = await db
      .insert(listings)
      .values({
        designId: src.designId,
        niche: "alpine",
        productType: "digital",
        title: "Minimal Swiss Alps Wall Art Printable",
        tags: src.tags,
        description: `A calm alpine scene.\n\n${AI_DISCLOSURE}`,
        imageUrl: "/api/placeholder/7?niche=alpine",
        priceChf: 8,
        podCostChf: 0,
        netChf: 6.37,
        marginPct: 79.7,
        validation: [],
        status: "published",
        publishMode: "dry-run",
        etsyListingId: `dry-${Math.random().toString(36).slice(2)}`,
        publishedAt: new Date(Date.now() + 60_000),
        isDemo: true,
        ...over,
      })
      .returning();
    return row;
  }

  it("pins a newly published listing once, in dry-run", async () => {
    const l = await published();
    const adapter = new PinterestDryRunAdapter();
    const run = makeRunPromote(async () => adapter);
    const summary = await run(ctx());
    expect(summary).toMatch(/dry-run/);
    const [p] = await db.select().from(promotions).where(eq(promotions.listingId, l.id));
    expect(p.status).toBe("posted");
    expect(p.pinId).toMatch(/^dry-pin-/);
    const call = adapter.calls.find((c) => c.link === etsyListingUrl(l.etsyListingId!));
    expect(call?.image.kind).toBe("base64");

    const before = adapter.calls.length;
    await run(ctx());
    const rows = await db.select().from(promotions).where(eq(promotions.listingId, l.id));
    expect(rows).toHaveLength(1);
    expect(adapter.calls.filter((c) => c.link === etsyListingUrl(l.etsyListingId!))).toHaveLength(1);
    expect(adapter.calls.length).toBeGreaterThanOrEqual(before);
  });

  it("claims a listing atomically", async () => {
    const l = await published();
    const [a, b] = await Promise.all([claimPromotion(db, l.id, "dry-run"), claimPromotion(db, l.id, "dry-run")]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it("retries failures up to the attempt limit, then stops", async () => {
    const l = await published();
    const failing = new FailingAdapter();
    const run = makeRunPromote(async () => failing);
    for (let i = 0; i < MAX_PIN_ATTEMPTS + 2; i++) await run(ctx()).catch(() => undefined);
    const [p] = await db.select().from(promotions).where(eq(promotions.listingId, l.id));
    expect(p.status).toBe("failed");
    expect(p.attempts).toBe(MAX_PIN_ATTEMPTS);
    expect(p.error).toMatch(/429/);
  });

  it("in live mode pins only listings that are live on Etsy", async () => {
    const dry = await published();
    const live = await published({ publishMode: "live", etsyListingId: "9988776655" });
    const recorder = new LiveRecorder();
    await makeRunPromote(async () => recorder)(ctx());
    expect(recorder.pins.map((p) => p.link)).toContain(etsyListingUrl("9988776655"));
    expect(recorder.pins.map((p) => p.link)).not.toContain(etsyListingUrl(dry.etsyListingId!));
    const [p] = await db.select().from(promotions).where(eq(promotions.listingId, live.id));
    expect(p.mode).toBe("live");
  });

  it("drops the promotion row when its listing is deleted, so the demo reseed still works", async () => {
    const l = await published();
    await claimPromotion(db, l.id, "dry-run");
    await db.delete(listings).where(eq(listings.id, l.id));
    expect(await db.select().from(promotions).where(eq(promotions.listingId, l.id))).toEqual([]);
  });

  it("stays dry-run without the go-live arm, even with Pinterest keys set", async () => {
    const keys = ["PINTEREST_APP_ID", "PINTEREST_APP_SECRET", "PINTEREST_BOARD_ID", "PINTEREST_ACCESS_TOKEN", "PINTEREST_REFRESH_TOKEN"];
    const prev = keys.map((k) => process.env[k]);
    keys.forEach((k) => (process.env[k] = "set"));
    try {
      const adapter = await getPinterestAdapter(db);
      expect(adapter.mode).toBe("dry-run");
    } finally {
      keys.forEach((k, i) => (prev[i] === undefined ? delete process.env[k] : (process.env[k] = prev[i])));
    }
  });
});
