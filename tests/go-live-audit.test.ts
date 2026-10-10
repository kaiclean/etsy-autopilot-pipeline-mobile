import path from "node:path";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { setImageProviderForTests } from "@/adapters/image";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { keywords, listings, shops } from "@/db/schema";
import { buildCockpitAlerts } from "@/lib/alerts";
import { integrationStatus } from "@/lib/config";
import { buildFileManifest, MANIFEST_MAX_BYTES } from "@/lib/file-manifest";
import { connectionHealth } from "@/lib/health";
import { encodeRgbPng } from "@/lib/png";
import { backfillDigitalManifests } from "@/pipeline/maintenance";
import { runStage } from "@/pipeline/runner";

const MEDIA_KEY = "designs/2026-10-10/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png";
const MEDIA_URL = `http://shop.test/api/media/${MEDIA_KEY}`;

const originalAppUrl = process.env.APP_URL;
const originalTrends = process.env.RESEARCH_GOOGLE_TRENDS;

function tinyPng(fill: number) {
  const rgb = new Uint8Array(2 * 2 * 3);
  rgb.fill(fill);
  return encodeRgbPng({ width: 2, height: 2, rgb });
}

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

afterEach(() => {
  setImageProviderForTests(null);
  if (originalAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = originalAppUrl;
  if (originalTrends === undefined) delete process.env.RESEARCH_GOOGLE_TRENDS;
  else process.env.RESEARCH_GOOGLE_TRENDS = originalTrends;
});

describe("digital file manifest", () => {
  it("reads /api/media bytes from storage and records size and sha256", async () => {
    const png = tinyPng(40);
    const manifest = await buildFileManifest(MEDIA_URL, "/api/preview?niche=alpine", {
      readObject: async (key) => (key === MEDIA_KEY ? { bytes: png } : null),
      fetchImpl: async () => {
        throw new Error("storage hit should not fetch");
      },
    });
    expect(manifest?.delivery).toMatchObject({ filename: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png", width: 2, height: 2, bytes: png.length });
    expect(manifest?.delivery.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest?.preview?.sha256).not.toBe(manifest?.delivery.sha256);
  });

  it("does not fetch a third-party URL and refuses an oversized own-origin response", async () => {
    let fetched = 0;
    const external = await buildFileManifest("https://cdn.example/secret.png", "/api/preview?niche=alpine", {
      fetchImpl: async () => {
        fetched++;
        return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response;
      },
    });
    expect(external).toBeNull();
    expect(fetched).toBe(0);

    process.env.APP_URL = "http://shop.test";
    let readBody = false;
    const capped = await buildFileManifest(MEDIA_URL, "/api/preview?niche=alpine", {
      readObject: async () => null,
      fetchImpl: async () =>
        ({
          ok: true,
          status: 200,
          headers: { get: (name: string) => (name === "content-length" ? String(MANIFEST_MAX_BYTES + 1) : null) },
          arrayBuffer: async () => {
            readBody = true;
            return new ArrayBuffer(0);
          },
        }) as unknown as Response,
    });
    expect(capped).toBeNull();
    expect(readBody).toBe(false);
  });

  it("backfills a digital row, including an early id such as listing 46", async () => {
    const db = await memoryDb();
    const shop = await omnishop(db);
    const png = tinyPng(90);
    const [row] = await db
      .insert(listings)
      .values({
        shopId: shop.id,
        niche: "alpine",
        productType: "digital",
        title: "Alpine download",
        tags: ["alpine art"],
        description: "A print.",
        imageUrl: "/api/preview?niche=alpine",
        deliveryUrl: `/api/media/${MEDIA_KEY}`,
        priceChf: 5.9,
        netChf: 3,
        marginPct: 50,
        isDemo: false,
      })
      .returning({ id: listings.id });
    const summary = await backfillDigitalManifests(db, {
      readObject: async () => ({ bytes: png }),
    });
    expect(summary.recorded).toBe(1);
    expect(summary.remaining).toBe(0);
    const [saved] = await db.select().from(listings).where(eq(listings.id, row.id));
    expect(saved.fileManifest?.delivery.bytes).toBe(png.length);
    expect(saved.fileManifest?.delivery.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("provider credit health", () => {
  it("marks image and LLM checks red or amber from the latest design run", () => {
    process.env.IMAGE_PROVIDER = "openai";
    process.env.LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.OPENAI_BASE_URL = "https://openrouter.ai/api/v1";
    const failed = connectionHealth({ etsyConnected: false, providerCredits: "failed" });
    expect(failed.find((check) => check.id === "images")).toMatchObject({ level: "red", label: "Out of credits" });
    expect(failed.find((check) => check.id === "llm")).toMatchObject({ level: "red", label: "Out of credits" });
    expect(JSON.stringify(failed)).not.toContain("sk-test");
    const warning = connectionHealth({ etsyConnected: false, providerCredits: "warning" });
    expect(warning.find((check) => check.id === "images")).toMatchObject({ level: "yellow", label: "Low credits" });
    expect(warning.find((check) => check.id === "llm")?.level).toBe("yellow");
    const rows = integrationStatus(false, { providerCredits: "failed" });
    expect(rows.find((row) => row.id === "images")?.status).toBe("missing");
    expect(rows.find((row) => row.id === "llm")?.detail).toContain("402");
    expect(JSON.stringify(rows)).not.toContain("sk-test");
    delete process.env.IMAGE_PROVIDER;
    delete process.env.LLM_PROVIDER;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
  });
});

describe("etsy id and token alerts", () => {
  const base = {
    cronRuns: [],
    nullEtsyIdCount: 0,
    deploySha: null,
    killSwitch: false,
    catalogDraftPending: false,
    now: Date.parse("2026-10-05T12:00:00Z"),
  };

  it("does not alert when the one-hour access token is near expiry", () => {
    const alerts = buildCockpitAlerts({
      ...base,
      tokens: {
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiresAt: Date.parse("2026-10-05T12:30:00Z"),
      },
    });
    expect(alerts.map((alert) => alert.id)).toEqual([]);
    expect(JSON.stringify(alerts)).not.toContain("access-token");
    expect(JSON.stringify(alerts)).not.toContain("refresh-token");
  });

  it("alerts when the refresh token is missing or the last refresh failed", () => {
    const missing = buildCockpitAlerts({
      ...base,
      tokens: { accessToken: "access-token", refreshToken: "", expiresAt: Date.parse("2026-10-20T00:00:00Z") },
    });
    expect(missing.map((alert) => alert.id)).toEqual(["oauth-refresh"]);
    expect(missing[0]?.title).toBe("Etsy refresh token missing");
    const failed = buildCockpitAlerts({
      ...base,
      tokens: {
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiresAt: Date.parse("2026-10-05T11:00:00Z"),
        refreshError: "Etsy token refresh failed (HTTP 400)",
      },
    });
    expect(failed[0]?.title).toBe("Etsy token refresh failed");
    expect(JSON.stringify(failed)).not.toContain("refresh-token");
  });
});

describe("keyword rotation", () => {
  it("returns a keyword to the backlog after repeated provider failures", async () => {
    const db = await memoryDb();
    const shop = await omnishop(db);
    await db.insert(keywords).values({
      shopId: shop.id,
      phrase: "repeat alpine ridge",
      niche: "alpine",
      source: "test",
      score: 10,
      status: "selected",
      designFailures: 1,
      isDemo: true,
    });
    setImageProviderForTests({
      name: "test",
      estimatedCostChf: 0,
      generate: async () => {
        throw new Error("provider timeout");
      },
    });
    const run = await runStage("design", "manual", { db, now: new Date(), random: () => 0.2 });
    expect(run.status).toBe("failed");
    const [row] = await db.select().from(keywords).where(eq(keywords.phrase, "repeat alpine ridge"));
    expect(row.designFailures).toBe(2);
    expect(row.status).toBe("new");
  });

  it("research selects a fresh backlog phrase ahead of one that already failed", async () => {
    process.env.RESEARCH_GOOGLE_TRENDS = "false";
    const db = await memoryDb();
    const shop = await omnishop(db);
    await db.insert(keywords).values([
      {
        shopId: shop.id,
        phrase: "fresh cabin study",
        niche: "alpine",
        source: "test",
        score: 1_000_000,
        status: "new",
        designFailures: 0,
        isDemo: true,
      },
      {
        shopId: shop.id,
        phrase: "tired gothic bloom",
        niche: "gothic",
        source: "test",
        score: 2_000_000,
        status: "new",
        designFailures: 2,
        isDemo: true,
      },
    ]);
    await runStage("research", "manual", { db, now: new Date(), random: () => 0.2 });
    const rows = await db.select().from(keywords);
    expect(rows.find((row) => row.phrase === "fresh cabin study")?.status).toBe("selected");
    expect(rows.find((row) => row.phrase === "tired gothic bloom")?.status).toBe("new");
  });
});
