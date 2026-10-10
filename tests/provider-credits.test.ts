import path from "node:path";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setImageProviderForTests } from "@/adapters/image";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { jobRuns, keywords, shops } from "@/db/schema";
import { buildCockpitAlerts } from "@/lib/alerts";
import { ImageProviderConfigurationError, isProviderCreditsError, yieldStatus } from "@/lib/provider-errors";
import { runStage } from "@/pipeline/runner";

const push = vi.hoisted(() => {
  const pushed: { type?: string; title?: string }[] = [];
  return {
    pushed,
    dispatchEventPush: async (_db: unknown, event: { type?: string; title?: string }) => {
      pushed.push({ type: event?.type, title: event?.title });
      return { sent: 1, removed: 0 };
    },
  };
});

vi.mock("@/lib/push", async () => {
  const actual = await vi.importActual<typeof import("@/lib/push")>("@/lib/push");
  return { ...actual, dispatchEventPush: push.dispatchEventPush };
});

const CREDITS = "OpenAI images failed: /images 402: Insufficient credits";

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

async function selectedKeywords(db: DB, shopId: string) {
  await db.insert(keywords).values([
    { shopId, phrase: "credits alpine ridge", niche: "alpine", source: "test", score: 90, status: "selected", isDemo: true },
    { shopId, phrase: "credits gothic bloom", niche: "gothic", source: "test", score: 80, status: "selected", isDemo: true },
    { shopId, phrase: "credits cabin night", niche: "christmas", source: "test", score: 70, status: "selected", isDemo: true },
  ]);
}

function creditPushes() {
  return push.pushed.filter((event) => event.title === "Image provider out of credits");
}

afterEach(() => {
  setImageProviderForTests(null);
  push.pushed.length = 0;
});

describe("provider yield", () => {
  it("fails only when work was attempted and nothing was produced", () => {
    expect(yieldStatus(0, 5)).toBe("failed");
    expect(yieldStatus(1, 2)).toBe("warning");
    expect(yieldStatus(0, 0)).toBe("success");
    expect(yieldStatus(3, 0)).toBe("success");
    expect(isProviderCreditsError("OpenAI images failed: /images 402: Insufficient credits")).toBe(true);
    expect(isProviderCreditsError("provider timeout")).toBe(false);
  });
});

describe("image credit alerts", () => {
  const base = {
    nullEtsyIdCount: 0,
    deploySha: null,
    tokens: { accessToken: "token", expiresAt: Date.parse("2026-10-20T12:00:00Z") },
    now: Date.parse("2026-10-08T06:00:00Z"),
    killSwitch: false,
    catalogDraftPending: false,
  };

  it("replaces the generic cron failure when every image call was out of credits", () => {
    const alerts = buildCockpitAlerts({
      ...base,
      cronRuns: [
        {
          stage: "daily",
          status: "failed",
          summary: "Image provider out of credits. Briefed 0, generated 0/5 designs",
          logs: [{ msg: "Generation failed: /images 402: Insufficient credits" }],
        },
      ],
    });
    expect(alerts.map((alert) => alert.id)).toEqual(["image-credits"]);
    expect(alerts[0]).toMatchObject({
      title: "Image provider out of credits",
      severity: "blocker",
      href: "/pipeline/live",
    });
    expect(alerts.find((alert) => alert.id === "cron-secret")).toBeUndefined();
  });

  it("surfaces a partial run on the alert rail", () => {
    const alerts = buildCockpitAlerts({
      ...base,
      cronRuns: [{ stage: "design", status: "warning", summary: "Briefed 0, generated 1/3 designs", logs: [{ msg: "provider timeout" }] }],
    });
    expect(alerts.map((alert) => alert.id)).toEqual(["cron-warning"]);
    expect(alerts[0].href).toBe("/pipeline/live");
  });
});

describe("design credit failures", () => {
  it("stops on an image endpoint configuration failure without cooling down keywords", async () => {
    const db = await memoryDb();
    const shop = await omnishop(db);
    await selectedKeywords(db, shop.id);
    const generate = vi.fn(async () => {
      throw new ImageProviderConfigurationError("Image endpoint 404. Set IMAGE_BASE_URL and IMAGE_MODEL.");
    });
    setImageProviderForTests({ name: "test", estimatedCostChf: 0, generate });

    const run = await runStage("design", "manual", { db, now: new Date(), random: () => 0.2 });
    expect(run.status).toBe("failed");
    expect(run.summary).toContain("IMAGE_BASE_URL");
    expect(generate).toHaveBeenCalledTimes(1);
    const rows = await db.select().from(keywords).where(eq(keywords.shopId, shop.id));
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.designFailures === 0 && row.status === "selected")).toBe(true);
  });

  it("fails the daily cron after one 402 and sends one push", async () => {
    const db = await memoryDb();
    const shop = await omnishop(db);
    const now = new Date();
    await db.insert(jobRuns).values({
      shopId: shop.id,
      stage: "research",
      status: "success",
      trigger: "cron",
      summary: "already researched",
      finishedAt: now,
      isDemo: true,
    });
    await selectedKeywords(db, shop.id);
    let calls = 0;
    setImageProviderForTests({
      name: "test",
      estimatedCostChf: 0,
      generate: async () => {
        calls++;
        throw new Error(CREDITS);
      },
    });

    const run = await runStage("daily", "cron", { db, now, random: () => 0.2 });
    expect(run.status).toBe("failed");
    expect(run.summary).toMatch(/Image provider out of credits/);
    expect(run.summary).toMatch(/generated 0\/3/);
    expect(calls).toBe(1);

    const rows = await db.select().from(jobRuns);
    expect(rows.find((row) => row.stage === "design")?.status).toBe("failed");
    const attempted = await db.select().from(keywords).where(eq(keywords.shopId, shop.id));
    expect(Object.fromEntries(attempted.map((row) => [row.phrase, [row.designFailures, row.status]]))).toEqual({
      "credits alpine ridge": [1, "selected"],
      "credits gothic bloom": [0, "selected"],
      "credits cabin night": [0, "selected"],
    });
    expect(creditPushes()).toEqual([{ type: "job.failed", title: "Image provider out of credits" }]);
  });

  it("warns when some images succeed and keeps going after a non-credit error", async () => {
    const db = await memoryDb();
    const shop = await omnishop(db);
    await selectedKeywords(db, shop.id);
    let calls = 0;
    setImageProviderForTests({
      name: "test",
      estimatedCostChf: 0,
      generate: async () => {
        calls++;
        if (calls === 1) return { url: "/api/placeholder/1?niche=alpine", costChf: 0, provider: "test" };
        throw new Error("provider timeout");
      },
    });

    const run = await runStage("design", "manual", { db, now: new Date(), random: () => 0.2 });
    expect(run.status).toBe("warning");
    expect(run.summary).toMatch(/generated 1\/3/);
    expect(run.summary).not.toMatch(/out of credits/);
    expect(calls).toBe(3);
    expect(creditPushes()).toEqual([]);
  });

  it("stops the rest of the run after a 402 that follows a success", async () => {
    const db = await memoryDb();
    const shop = await omnishop(db);
    await selectedKeywords(db, shop.id);
    let calls = 0;
    setImageProviderForTests({
      name: "test",
      estimatedCostChf: 0,
      generate: async () => {
        calls++;
        if (calls === 1) return { url: "/api/placeholder/1?niche=alpine", costChf: 0, provider: "test" };
        throw new Error(CREDITS);
      },
    });

    const run = await runStage("design", "cron", { db, now: new Date(), random: () => 0.2 });
    expect(run.status).toBe("warning");
    expect(run.summary).toMatch(/^Image provider out of credits/);
    expect(run.summary).toMatch(/generated 1\/3/);
    expect(calls).toBe(2);
    expect(creditPushes()).toEqual([{ type: "job.failed", title: "Image provider out of credits" }]);
  });
});
