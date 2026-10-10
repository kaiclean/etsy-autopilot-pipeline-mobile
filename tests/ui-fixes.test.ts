import path from "node:path";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setImageProviderForTests } from "@/adapters/image";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { designs, keywords, listings, shops } from "@/db/schema";
import { artRegenerationBlocker } from "@/lib/art-queue";
import { filterProducts } from "@/lib/catalog-filters";
import { connectionHealth } from "@/lib/health";
import { formatMaintenanceSummary } from "@/lib/maintenance-summary";
import { runDesign } from "@/pipeline/design";
import type { StageContext } from "@/pipeline/types";

const ENV_KEYS = ["IMAGE_PROVIDER", "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_IMAGE_MODEL"] as const;
const original = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreEnv() {
  for (const key of ENV_KEYS) {
    const value = original[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  restoreEnv();
  setImageProviderForTests(null);
  vi.unstubAllGlobals();
});

const MAINTENANCE = JSON.stringify({
  webhooks: { existing: 0, created: 0, skipped: 7, reason: "demo mode" },
  images: { rewritten: 0, remaining: 0, reason: null },
  fakeRows: { orders: 0, costs: 0, daily_stats: 0, job_runs: 0, events: 0, reason: "demo mode" },
});

describe("maintenance summary", () => {
  it("renders webhook and fake-order counts instead of JSON", () => {
    expect(formatMaintenanceSummary(MAINTENANCE)).toBe("Webhooks 7 ok · 0 fake orders cleaned");
    expect(
      formatMaintenanceSummary(
        JSON.stringify({
          webhooks: { existing: 5, created: 2, skipped: 0, reason: null },
          images: { rewritten: 0, remaining: 0, reason: null },
          fakeRows: { orders: 3, costs: 1, daily_stats: 0, job_runs: 0, events: 0, reason: null },
        }),
      ),
    ).toBe("Webhooks 7 ok · 3 fake orders cleaned");
    expect(formatMaintenanceSummary("Stage paused")).toBe("Stage paused");
  });
});

describe("image provider last error", () => {
  it("replaces Ready with the latest design-run failure", () => {
    process.env.IMAGE_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.OPENAI_BASE_URL = "https://ollama.com/v1";
    process.env.OPENAI_IMAGE_MODEL = "gpt-image-1";
    const run = {
      status: "failed",
      summary: "Briefed 0, generated 0/5 designs",
      logs: [{ msg: "Generation failed for “alps”: OpenAI images failed: /images/generations 404: model not served" }],
    };
    const images = connectionHealth({ etsyConnected: false, imageRun: run }).find((check) => check.id === "images");
    expect(images?.label).toBe("404");
    expect(images?.level).toBe("red");
    expect(images?.detail).toContain("404");
    expect(images?.detail).not.toContain("sk-test");
    expect(JSON.stringify(images)).not.toContain("sk-test");
  });

  it("keeps a missing key ahead of a stale 404", () => {
    process.env.IMAGE_PROVIDER = "openai";
    delete process.env.OPENAI_API_KEY;
    delete process.env.IMAGE_API_KEY;
    const images = connectionHealth({
      etsyConnected: false,
      imageRun: { status: "failed", summary: "OpenAI images failed: /images/generations 404", logs: [] },
    }).find((check) => check.id === "images");
    expect(images?.label).toBe("Key missing");
  });

  it("names a credits failure from the latest run", () => {
    process.env.IMAGE_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-test";
    const images = connectionHealth({
      etsyConnected: false,
      imageRun: { status: "failed", summary: "Image provider out of credits. Briefed 0, generated 0/5", logs: [] },
    }).find((check) => check.id === "images");
    expect(images?.label).toBe("Out of credits");
    expect(images?.level).toBe("red");
  });
});

describe("placeholder art queue", () => {
  it("filters placeholder products and refuses a broken provider", () => {
    const rows = [
      { id: 1, title: "Alps", tags: ["alps"], niche: "alpine", status: "published", imageUrl: "/api/placeholder/1" },
      { id: 2, title: "Real", tags: ["real"], niche: "alpine", status: "published", imageUrl: "https://cdn.example/a.png" },
    ];
    expect(filterProducts(rows, { query: "", niche: "all", status: "all", art: "placeholder" }).map((row) => row.id)).toEqual([1]);
    expect(filterProducts(rows, { query: "", niche: "all", status: "all" }).map((row) => row.id)).toEqual([1, 2]);
    expect(artRegenerationBlocker("mock", null)).toMatch(/mock/);
    expect(
      artRegenerationBlocker("openai", {
        status: "failed",
        summary: "OpenAI images failed: /images/generations 404",
        logs: [],
      }),
    ).toMatch(/404/);
    expect(artRegenerationBlocker("omniroute", { status: "success", summary: "Briefed 1, generated 1/1", logs: [] })).toBeNull();
  });

  it("replaces placeholder art on the next design run and does not publish", async () => {
    const client = new PGlite("memory://");
    const db = drizzle(client, { schema }) as unknown as DB;
    await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
    const [shop] = await db.select().from(shops).where(eq(shops.slug, "omnishop-ch"));
    const [keyword] = await db
      .insert(keywords)
      .values({ shopId: shop.id, phrase: "queued alpine ridge", niche: "alpine", source: "test", score: 90, status: "selected", isDemo: false })
      .returning();
    const url = "https://cdn.example/queued-alpine.png";
    vi.stubGlobal("fetch", async () => ({ ok: false, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) }));
    setImageProviderForTests({
      name: "openai",
      estimatedCostChf: 0.01,
      generate: async () => ({ url, costChf: 0.01, provider: "openai" }),
    });
    const [design] = await db
      .insert(designs)
      .values({
        shopId: shop.id,
        keywordId: keyword.id,
        niche: "alpine",
        prompt: "old",
        provider: "mock",
        imageUrl: "/api/placeholder/9",
        status: "listed",
        isDemo: false,
      })
      .returning();
    const [listing] = await db
      .insert(listings)
      .values({
        shopId: shop.id,
        designId: design.id,
        keywordId: keyword.id,
        niche: "alpine",
        productType: "digital",
        title: "Alpine print",
        tags: ["alpine"],
        description: "A print",
        imageUrl: "/api/placeholder/9",
        deliveryUrl: "/api/placeholder/9",
        fileManifest: {
          delivery: { filename: "9.png", width: 64, height: 64, bytes: 100, sha256: "a".repeat(64) },
        },
        fileVerifiedAt: new Date("2026-10-09T12:00:00Z"),
        fileVerifiedBy: "kai",
        priceChf: 12.5,
        netChf: 4,
        marginPct: 30,
        status: "pending_approval",
        publishMode: "dry-run",
        isDemo: false,
      })
      .returning();

    const ctx: StageContext = {
      db,
      shopId: shop.id,
      demo: false,
      trigger: "manual",
      random: () => 0.1,
      now: new Date("2026-10-10T12:00:00Z"),
      log: () => {},
    };
    await runDesign(ctx);

    const [updated] = await db.select().from(listings).where(eq(listings.id, listing.id));
    const [kw] = await db.select().from(keywords).where(eq(keywords.id, keyword.id));
    const designRows = await db.select().from(designs).where(eq(designs.keywordId, keyword.id));
    expect(updated.status).toBe("pending_approval");
    expect(updated.publishMode).toBe("dry-run");
    expect(updated.etsyListingId).toBeNull();
    expect(updated.imageUrl).toBe(url);
    expect(updated.deliveryUrl).toBe(url);
    expect(updated.fileManifest).toBeNull();
    expect(updated.fileVerifiedAt).toBeNull();
    expect(updated.fileVerifiedBy).toBeNull();
    expect(kw.status).toBe("used");
    expect(designRows).toHaveLength(1);
    expect(designRows[0].imageUrl).toBe(url);
  });

  it("does not write live art onto seeded demo rows for the same keyword", async () => {
    const client = new PGlite("memory://");
    const db = drizzle(client, { schema }) as unknown as DB;
    await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
    const [shop] = await db.select().from(shops).where(eq(shops.slug, "omnishop-ch"));
    const [keyword] = await db
      .insert(keywords)
      .values({ shopId: shop.id, phrase: "claimed seed phrase", niche: "alpine", source: "test", score: 90, status: "selected", isDemo: false })
      .returning();
    const url = "https://cdn.example/live-alpine.png";
    vi.stubGlobal("fetch", async () => ({ ok: false, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) }));
    setImageProviderForTests({
      name: "openai",
      estimatedCostChf: 0.01,
      generate: async () => ({ url, costChf: 0.01, provider: "openai" }),
    });
    const [demoListing] = await db
      .insert(listings)
      .values({
        shopId: shop.id,
        keywordId: keyword.id,
        niche: "alpine",
        productType: "digital",
        title: "Seeded alpine print",
        tags: ["alpine"],
        description: "A print",
        imageUrl: "/api/placeholder/3",
        deliveryUrl: "/api/placeholder/3",
        priceChf: 12.5,
        netChf: 4,
        marginPct: 30,
        status: "pending_approval",
        publishMode: "dry-run",
        isDemo: true,
      })
      .returning();

    await runDesign({
      db,
      shopId: shop.id,
      demo: false,
      trigger: "manual",
      random: () => 0.1,
      now: new Date("2026-10-10T12:00:00Z"),
      log: () => {},
    });

    const [unchanged] = await db.select().from(listings).where(eq(listings.id, demoListing.id));
    expect(unchanged.imageUrl).toBe("/api/placeholder/3");
    const liveDesigns = await db.select().from(designs).where(eq(designs.keywordId, keyword.id));
    expect(liveDesigns.some((row) => row.imageUrl === url && row.isDemo === false)).toBe(true);
  });
});
