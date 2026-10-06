import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toPrintifyWebhookRefs } from "@/adapters/printify/client";
import type { DB } from "@/db";
import { cleanupFakeOrdersIfPresent } from "@/db/clear-fake-orders";
import * as schema from "@/db/schema";
import { jobRuns, listings, orders, shops } from "@/db/schema";
import { connectionHealth } from "@/lib/health";
import { backfillInlineImages, IMAGE_BACKFILL_BATCH_LIMIT } from "@/lib/image-backfill";
import { PRINTIFY_WEBHOOK_TOPICS } from "@/lib/ops-copy";
import { ensurePrintifyWebhooks, printifyWebhookCallbackUrl, registeredWebhookCount, type PrintifyWebhookClient } from "@/lib/printify-webhooks";
import { runMaintenanceTasks } from "@/pipeline/maintenance";
import { runStage } from "@/pipeline/runner";

const ENV_KEYS = [
  "DEMO_MODE",
  "PUBLISH_MODE",
  "PRINTIFY_API_TOKEN",
  "PRINTIFY_SHOP_ID",
  "PRINTIFY_WEBHOOK_SECRET",
  "APP_URL",
  "PUBLIC_BASE_URL",
  "RAILWAY_PUBLIC_DOMAIN",
  "ETSY_API_KEY",
  "ETSY_SHARED_SECRET",
  "ETSY_SHOP_ID",
] as const;

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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function livePrintifyEnv() {
  process.env.DEMO_MODE = "false";
  process.env.PUBLISH_MODE = "live";
  process.env.PRINTIFY_API_TOKEN = "printify-token-test";
  process.env.PRINTIFY_SHOP_ID = "12345";
  process.env.PRINTIFY_WEBHOOK_SECRET = "whsec-do-not-log";
  process.env.APP_URL = "https://shop.example";
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

describe("Printify webhook registration", () => {
  it("creates only topics that are not already registered to our URL", async () => {
    livePrintifyEnv();
    const callback = printifyWebhookCallbackUrl();
    const secret = process.env.PRINTIFY_WEBHOOK_SECRET!;
    const rows: { topic: string; url: string }[] = [
      { topic: "order:created", url: callback },
      { topic: "order:updated", url: "https://elsewhere.example/hook" },
    ];
    const created: string[] = [];
    const client: PrintifyWebhookClient = {
      async listWebhooks() {
        return rows.map((row) => ({ topic: row.topic, url: row.url }));
      },
      async createWebhook(input) {
        expect(input.secret).toBe(secret);
        expect(input.url).toBe(callback);
        created.push(input.topic);
        rows.push({ topic: input.topic, url: input.url });
      },
    };
    const logs: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      });
    }

    const first = await ensurePrintifyWebhooks({ client });
    expect(first.existing).toBe(1);
    expect(first.created).toBe(PRINTIFY_WEBHOOK_TOPICS.length - 1);
    expect(first.skipped).toBe(0);
    expect(first.reason).toBeNull();
    expect(created).not.toContain("order:created");
    expect(created).toContain("order:updated");
    expect(created).toContain("product:publish:started");
    expect(created).toContain("product:publish:succeeded");
    expect(created).toHaveLength(PRINTIFY_WEBHOOK_TOPICS.length - 1);

    const second = await ensurePrintifyWebhooks({ client });
    expect(second).toMatchObject({ existing: PRINTIFY_WEBHOOK_TOPICS.length, created: 0, skipped: 0, reason: null });
    expect(created).toHaveLength(PRINTIFY_WEBHOOK_TOPICS.length - 1);
    expect(JSON.stringify([first, second])).not.toContain(secret);
    expect(JSON.stringify([first, second])).not.toContain("printify-token-test");
    expect(logs.join("\n")).not.toContain(secret);
  });

  it("skips the Printify client in dry-run and when credentials are missing", async () => {
    const client: PrintifyWebhookClient = {
      async listWebhooks() {
        throw new Error("client should not be called");
      },
      async createWebhook() {
        throw new Error("client should not be called");
      },
    };
    process.env.DEMO_MODE = "false";
    process.env.PUBLISH_MODE = "dry-run";
    process.env.PRINTIFY_API_TOKEN = "printify-token-test";
    process.env.PRINTIFY_SHOP_ID = "12345";
    process.env.PRINTIFY_WEBHOOK_SECRET = "whsec-do-not-log";
    const dry = await ensurePrintifyWebhooks({ client });
    expect(dry.reason).toBe("dry-run");
    expect(dry.created).toBe(0);
    expect(dry.skipped).toBe(PRINTIFY_WEBHOOK_TOPICS.length);

    process.env.PUBLISH_MODE = "live";
    delete process.env.PRINTIFY_API_TOKEN;
    const missing = await ensurePrintifyWebhooks({ client });
    expect(missing.reason).toBe("missing PRINTIFY_API_TOKEN");
    expect(missing.skipped).toBe(PRINTIFY_WEBHOOK_TOPICS.length);

    process.env.DEMO_MODE = "true";
    process.env.PRINTIFY_API_TOKEN = "printify-token-test";
    const demo = await ensurePrintifyWebhooks({ client });
    expect(demo.reason).toBe("demo mode");
  });

  it("builds the callback from APP_URL, then Railway, then the production host", () => {
    expect(printifyWebhookCallbackUrl({ APP_URL: "https://shop.example/" })).toBe("https://shop.example/api/webhooks/printify");
    expect(printifyWebhookCallbackUrl({ APP_URL: "https://user:pass@shop.example/base/" })).toBe(
      "https://shop.example/base/api/webhooks/printify",
    );
    expect(printifyWebhookCallbackUrl({ PUBLIC_BASE_URL: "https://public.example" })).toBe("https://public.example/api/webhooks/printify");
    expect(printifyWebhookCallbackUrl({ APP_URL: "https://shop.example", PUBLIC_BASE_URL: "https://public.example" })).toBe(
      "https://shop.example/api/webhooks/printify",
    );
    expect(printifyWebhookCallbackUrl({ RAILWAY_PUBLIC_DOMAIN: "shop.up.railway.app" })).toBe(
      "https://shop.up.railway.app/api/webhooks/printify",
    );
    expect(printifyWebhookCallbackUrl({})).toBe("https://etsy-autopilot-production-8b9f.up.railway.app/api/webhooks/printify");
  });

  it("drops webhook secrets returned by Printify and redacts them from errors", async () => {
    const refs = toPrintifyWebhookRefs([
      { id: "wh_1", topic: "order:created", url: "https://shop.example/api/webhooks/printify", secret: "stored-secret" },
    ]);
    expect(refs).toEqual([{ topic: "order:created", url: "https://shop.example/api/webhooks/printify" }]);
    expect(JSON.stringify(refs)).not.toContain("stored-secret");

    livePrintifyEnv();
    const secret = process.env.PRINTIFY_WEBHOOK_SECRET!;
    const token = process.env.PRINTIFY_API_TOKEN!;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      expect(String(input)).toBe("https://api.printify.com/v1/shops/12345/webhooks.json");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
      if (method === "GET") return new Response(`[{"secret":"${secret}"}]`, { status: 500 });
      return new Response("nope", { status: 500 });
    });
    const failed = await ensurePrintifyWebhooks();
    expect(failed.reason).toContain("[redacted]");
    expect(failed.reason).not.toContain(secret);
    expect(failed.reason).not.toContain(token);
    expect(JSON.stringify(failed)).not.toContain(secret);
  });
});

describe("fake-order cleanup", () => {
  it("refuses while DEMO_MODE=true and leaves the rows in place", async () => {
    process.env.DEMO_MODE = "true";
    const db = await memoryDb();
    const shop = await omnishop(db);
    await db.insert(orders).values({
      shopId: shop.id,
      etsyReceiptId: "dry-r-keep",
      buyerCountry: "CH",
      totalChf: 10,
      feesChf: 1,
      profitChf: 2,
      fulfillmentStatus: "pending",
      isDemo: true,
    });
    await expect(cleanupFakeOrdersIfPresent(db)).rejects.toThrow(/DEMO_MODE=true/);
    const summary = await runMaintenanceTasks(db);
    expect(summary.fakeRows.orders).toBe(0);
    expect(summary.fakeRows.reason).toMatch(/DEMO_MODE=true/);
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(orders);
    expect(Number(n)).toBe(1);
    expect(JSON.stringify(summary)).not.toContain("whsec");
  });

  it("deletes matching rows once, then stays at zero", async () => {
    process.env.DEMO_MODE = "false";
    const db = await memoryDb();
    const shop = await omnishop(db);
    await db.insert(orders).values({
      shopId: shop.id,
      etsyReceiptId: "dry-r-1",
      buyerCountry: "CH",
      totalChf: 10,
      feesChf: 1,
      profitChf: 2,
      fulfillmentStatus: "pending",
      isDemo: false,
    });
    await db.insert(orders).values({
      shopId: shop.id,
      etsyReceiptId: "3899001-1",
      buyerCountry: "CH",
      totalChf: 12,
      feesChf: 1,
      profitChf: 4,
      fulfillmentStatus: "pending",
      isDemo: false,
    });
    const deleted = await cleanupFakeOrdersIfPresent(db);
    expect(deleted.orders).toBe(1);
    const remaining = await db.select({ id: orders.etsyReceiptId }).from(orders);
    expect(remaining.map((row) => row.id)).toEqual(["3899001-1"]);
    const again = await cleanupFakeOrdersIfPresent(db);
    expect(again.orders).toBe(0);
  });
});

describe("inline image backfill batch", () => {
  it("rewrites at most the batch limit and reports the rows still inline", async () => {
    const db = await memoryDb();
    for (let i = 0; i < 12; i++) {
      await db.insert(listings).values({
        niche: "alpine",
        productType: "digital",
        title: `Inline ${i}`,
        tags: ["print"],
        description: "short",
        imageUrl: `data:image/png;base64,${String(i).padStart(4, "0")}aaaa`,
        priceChf: 8,
        netChf: 5,
        marginPct: 70,
        isDemo: false,
      });
    }
    let uploads = 0;
    const report = await backfillInlineImages(
      db,
      async () => {
        uploads += 1;
        return `https://cdn.example/designs/${uploads}.png`;
      },
      { limit: IMAGE_BACKFILL_BATCH_LIMIT },
    );
    expect(IMAGE_BACKFILL_BATCH_LIMIT).toBe(10);
    expect(uploads).toBe(10);
    expect(report.updatedListings).toBe(10);
    expect(report.remaining).toBe(2);
    expect(report.listingCandidates).toBe(12);

    const second = await backfillInlineImages(
      db,
      async () => {
        uploads += 1;
        return `https://cdn.example/designs/${uploads}.png`;
      },
      { limit: IMAGE_BACKFILL_BATCH_LIMIT },
    );
    expect(second.updatedListings).toBe(2);
    expect(second.remaining).toBe(0);
    expect(uploads).toBe(12);
  });
});

describe("maintenance cron", () => {
  it("records a maintenance job from the orders cron without failing that stage", async () => {
    process.env.DEMO_MODE = "true";
    const db = await memoryDb();
    const ordersRun = await runStage("orders", "cron", { db, random: () => 0 });
    expect(ordersRun.status).toBe("success");
    expect(ordersRun.summary).toContain("new order");
    expect(ordersRun.logs.some((line) => line.msg === "maintenance success")).toBe(true);
    const [maintenance] = await db.select().from(jobRuns).where(eq(jobRuns.stage, "maintenance"));
    expect(maintenance.status).toBe("success");
    const summary = JSON.parse(maintenance.summary ?? "{}") as { webhooks: { reason: string } };
    expect(summary.webhooks.reason).toBe("demo mode");

    await runStage("orders", "manual", { db, random: () => 0 });
    const rows = await db.select({ id: jobRuns.id }).from(jobRuns).where(eq(jobRuns.stage, "maintenance"));
    expect(rows).toHaveLength(1);
  });

  it("reads Webhooks: N registered from the last maintenance summary", () => {
    const summary = JSON.stringify({
      webhooks: { existing: 5, created: 2, skipped: 0, reason: null },
      images: { rewritten: 0, remaining: 0, reason: null },
      fakeRows: { orders: 0, costs: 0, daily_stats: 0, job_runs: 0, events: 0, reason: null },
    });
    expect(registeredWebhookCount(summary)).toBe(7);
    expect(registeredWebhookCount(JSON.stringify({ webhooks: { existing: 0, created: 0, skipped: 7, reason: "dry-run" } }))).toBeNull();
    const detail = connectionHealth({ etsyConnected: false, webhooksRegistered: 7 }).find((check) => check.id === "printify")?.detail;
    expect(detail).toContain("Webhooks: 7 registered");
    expect(detail).not.toContain("whsec");
  });
});
