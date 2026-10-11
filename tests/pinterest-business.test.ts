import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pinterestWriteAllowed } from "@/businesses/pinterest/access";
import { runPinterestDrafts, runPinterestPublish } from "@/businesses/pinterest/stage";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { approvalItems, listings, shops } from "@/db/schema";
import { buildPinCopy, PIN_LIMITS } from "@/lib/pin-copy";
import type { StageContext } from "@/pipeline/types";

const migrationsFolder = path.join(process.cwd(), "drizzle");
const token = "pin-token-test";

function ctx(db: DB, shopId: string, logs: string[]): StageContext {
  return {
    db,
    shopId,
    demo: true,
    trigger: "manual",
    random: () => 0.2,
    now: new Date("2026-10-11T06:00:00Z"),
    log: (msg) => logs.push(msg),
  };
}

async function fixture() {
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as DB;
  await migrate(db, { migrationsFolder });
  const [etsy] = await db.select().from(shops).where(eq(shops.slug, "omnishop-ch"));
  const [pin] = await db.select().from(shops).where(eq(shops.slug, "pinterest"));
  const image = "https://example-bucket.s3.amazonaws.com/designs/alpine.png";
  await db.insert(listings).values([
    {
      shopId: etsy.id,
      niche: "alpine",
      productType: "digital",
      title: "Alpine lake wall art print",
      tags: ["alpine"],
      description: "A quiet alpine lake.\n\nWHAT YOU GET\n\nFiles.",
      imageUrl: image,
      priceChf: 12,
      netChf: 8,
      marginPct: 70,
      status: "published",
      etsyListingId: "1234567890",
      isDemo: false,
    },
    {
      shopId: etsy.id,
      niche: "gothic",
      productType: "digital",
      title: "No id yet",
      tags: ["gothic"],
      description: "Hidden",
      imageUrl: image,
      priceChf: 12,
      netChf: 8,
      marginPct: 70,
      status: "published",
      etsyListingId: null,
      isDemo: false,
    },
  ]);
  return { client, db, etsy, pin, image };
}

describe("Pinterest business drafts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.PINTEREST_ACCESS_TOKEN;
    delete process.env.PINTEREST_ACCESS;
  });

  it("clips pin copy and refuses writes unless token, live, and Standard access", () => {
    const copy = buildPinCopy({
      title: "A".repeat(180),
      description: "A quiet alpine lake at dawn.",
      etsyListingId: "1234567890",
    });
    expect(copy.title.length).toBeLessThanOrEqual(PIN_LIMITS.title);
    expect(copy.description.length).toBeLessThanOrEqual(PIN_LIMITS.description);
    expect(copy.altText.length).toBeLessThanOrEqual(PIN_LIMITS.altText);
    expect(copy.link).toBe("https://www.etsy.com/listing/1234567890");
    expect(pinterestWriteAllowed({ accessToken: null, publishMode: "live", access: "standard" }).ok).toBe(false);
    expect(pinterestWriteAllowed({ accessToken: token, publishMode: "dry-run", access: "standard" }).ok).toBe(false);
    expect(pinterestWriteAllowed({ accessToken: token, publishMode: "live", access: "trial" }).ok).toBe(false);
    expect(pinterestWriteAllowed({ accessToken: token, publishMode: "live", access: "standard" }).ok).toBe(true);
  });

  it("drafts one pin per active Etsy listing and does not call Pinterest", async () => {
    const fetchMock = vi.fn(() => {
      throw new Error("network should not be called");
    });
    vi.stubGlobal("fetch", fetchMock);
    process.env.PINTEREST_ACCESS_TOKEN = token;
    process.env.PINTEREST_ACCESS = "standard";
    const { client, db, pin, image } = await fixture();
    try {
      await db.update(shops).set({ publishMode: "live", status: "live" }).where(eq(shops.id, pin.id));
      const logs: string[] = [];
      const summary = await runPinterestDrafts(ctx(db, pin.id, logs));
      expect(summary).toMatch(/Drafted 1 pin/);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(logs.join("\n")).not.toContain(token);
      const again = await runPinterestDrafts(ctx(db, pin.id, logs));
      expect(again).toMatch(/Drafted 0 pins, 1 already queued/);
      const items = await db.select().from(approvalItems);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ shopId: pin.id, action: "pin", status: "pending_approval" });
      expect(items[0].payload).toMatchObject({
        title: "Alpine lake wall art print",
        board: "Etsy listings",
        imageUrl: image,
        destinationLink: "https://www.etsy.com/listing/1234567890",
        access: "standard",
      });
      expect(String((items[0].payload as { description?: string }).description)).toContain("Designed with AI");
      expect((items[0].payload as { description?: string }).description).not.toMatch(/WHAT YOU GET/);
    } finally {
      await client.close();
    }
  });

  it("publishes an approved pin only when the business is confirmed live with Standard access", async () => {
    const { client, db, pin } = await fixture();
    const logs: string[] = [];
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ id: "pin_123" }) }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await runPinterestDrafts(ctx(db, pin.id, logs));
      const [item] = await db.select().from(approvalItems);
      await db.update(approvalItems).set({ status: "approved" }).where(eq(approvalItems.id, item.id));

      process.env.PINTEREST_ACCESS_TOKEN = token;
      process.env.PINTEREST_ACCESS = "standard";
      const dry = await runPinterestPublish(ctx(db, pin.id, logs));
      expect(dry).toMatch(/not confirmed live/);
      expect(fetchMock).not.toHaveBeenCalled();

      await db.update(shops).set({ publishMode: "live", status: "live" }).where(eq(shops.id, pin.id));
      process.env.PINTEREST_ACCESS = "trial";
      const trial = await runPinterestPublish(ctx(db, pin.id, logs));
      expect(trial).toMatch(/Trial access/);
      expect(fetchMock).not.toHaveBeenCalled();

      process.env.PINTEREST_ACCESS = "standard";
      const live = await runPinterestPublish(ctx(db, pin.id, logs));
      expect(live).toMatch(/Pinned 1, failed 0/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(call[0]).toBe("https://api.pinterest.com/v5/pins");
      expect(logs.join("\n")).not.toContain(token);
      const [published] = await db.select().from(approvalItems);
      expect(published.status).toBe("published");
      expect(published.payload).toMatchObject({ pinId: "pin_123" });
    } finally {
      await client.close();
    }
  });
});
