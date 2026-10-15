import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { fromPglite, PgBoss } from "pg-boss";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { etsyEvents, etsyListingObservations } from "@/db/etsy-events";
import {
  ETSY_WEBHOOK_MAX_BYTES, parseEtsyResourceUrl, readEtsyWebhookBody, recordEtsyDelivery, verifyEtsyWebhook,
} from "@/lib/etsy-webhook";
import {
  dispatchEtsyEvents, drainEtsyEvents, etsyQueueDatabaseUrl, ETSY_EVENT_MAX_ATTEMPTS,
  ETSY_EVENT_QUEUE, ETSY_DEAD_LETTER_QUEUE, processEtsyEvent, replayEtsyEvent, type EtsyQueue,
} from "@/lib/etsy-jobs";
import { reconcileEtsyEvent } from "@/pipeline/etsy-reconcile";
import { POST } from "@/app/api/webhooks/etsy/route";
import { GET, POST as operatorPost } from "@/app/api/cron/etsy-events/route";

const mocks = vi.hoisted(() => ({
  getEtsyAdapter: vi.fn(), saveReceipts: vi.fn(), getSetting: vi.fn(), getDb: vi.fn(),
}));
vi.mock("@/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/adapters/etsy", () => ({ getEtsyAdapter: mocks.getEtsyAdapter }));
vi.mock("@/pipeline/orders", () => ({ saveReceipts: mocks.saveReceipts }));
vi.mock("@/lib/settings", () => ({ getSetting: mocks.getSetting }));

const shopId = "11111111-1111-4111-8111-111111111111";
const now = new Date("2026-10-15T18:00:00Z");
const raw = () => new TextEncoder().encode(JSON.stringify({
  shop_id: 42, event_type: "listing.updated",
  resource_url: "https://api.etsy.com/v3/application/listings/123",
  listing_id: 123, ignored_buyer_email: "must-not-be-stored@example.invalid",
}));
const trustedFixture = (id = "verified-fixture-delivery") => async () => ({ deliveryId: id, timestamp: now.getTime() });
let client: PGlite;
let db: DB;

function queueMock() {
  const jobs = new Map<string, { id: string; name: string; data: { eventId: string }; retryCount: number }>();
  const send = vi.fn(async (name: string, data: { eventId: string }, options: { id: string }) => {
    if (jobs.has(options.id)) return null;
    jobs.set(options.id, { id: options.id, name, data, retryCount: 0 });
    return options.id;
  });
  const fetch = vi.fn(async () => {
    const job = jobs.values().next().value;
    if (job) jobs.delete(job.id);
    return job ? [job] : [];
  });
  return { send, fetch, complete: vi.fn(async () => ({})), fail: vi.fn(async () => ({})) };
}

async function insertEvent(deliveryId = randomUUID()) {
  await recordEtsyDelivery(db, raw(), new Headers(), trustedFixture(deliveryId), now);
  return (await db.select().from(etsyEvents))[0];
}

beforeAll(async () => {
  client = new PGlite();
  const dir = path.join(process.cwd(), "drizzle");
  for (const file of readdirSync(dir).filter((f) => /^\d{4}.*\.sql$/.test(f) && f.slice(0, 4) <= "0019").sort()) {
    for (const statement of readFileSync(path.join(dir, file), "utf8").split("--> statement-breakpoint").filter((s) => s.trim())) {
      await client.exec(statement);
    }
  }
  db = drizzle(client, { schema });
  await client.query(`INSERT INTO shops (id, slug, display_name, etsy_shop_id) VALUES ($1, 'webhook-test', 'Webhook test', '42')`, [shopId]);
}, 60_000);
afterAll(async () => { await client?.close(); });
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.getDb.mockResolvedValue(db);
  mocks.getSetting.mockResolvedValue({ killSwitch: false });
  await client.exec("DELETE FROM etsy_events; DELETE FROM etsy_listing_observations;");
  await client.query("UPDATE shops SET kill_switch = false, status = 'live' WHERE id = $1", [shopId]);
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("fail-closed Etsy webhook", () => {
  it("stays unavailable even with opt-in and plausible attacker-supplied signature headers", async () => {
    vi.stubEnv("ETSY_WEBHOOK_ENABLED", "true");
    const request = new Request("http://localhost/api/webhooks/etsy", {
      method: "POST", headers: { "content-type": "application/json", "x-etsy-signature": "forged" }, body: raw(),
    });
    expect((await POST(request)).status).toBe(503);
    expect(await db.select().from(etsyEvents)).toHaveLength(0);
    await expect(verifyEtsyWebhook(raw(), request.headers)).rejects.toMatchObject({ status: 503 });
  });

  it("defaults off and requires no database or queue to reject delivery", async () => {
    vi.stubEnv("ETSY_WEBHOOK_ENABLED", "");
    expect((await POST(new Request("http://localhost", { method: "POST", body: "{}" }))).status).toBe(503);
  });

  it("bounds declared and streamed body length", async () => {
    vi.stubEnv("ETSY_WEBHOOK_ENABLED", "true");
    const oversized = new Uint8Array(ETSY_WEBHOOK_MAX_BYTES + 1);
    expect((await POST(new Request("http://localhost", {
      method: "POST", headers: { "content-length": String(oversized.length) }, body: oversized,
    }))).status).toBe(413);
    await expect(readEtsyWebhookBody(new Request("http://localhost", {
      method: "POST", headers: { "content-length": "1" }, body: oversized,
    }))).rejects.toMatchObject({ status: 413 });
  });

  it("cancels a stalled delivery body instead of holding the route indefinitely", async () => {
    vi.useFakeTimers();
    const request = new Request("http://localhost", { method: "POST", body: "{}" });
    Object.defineProperty(request, "body", { value: new ReadableStream<Uint8Array>() });
    const reading = expect(readEtsyWebhookBody(request)).rejects.toMatchObject({ status: 408 });
    await vi.advanceTimersByTimeAsync(10_001);
    await reading;
  });

  it("rejects expired/future verified timestamps and unregistered shops", async () => {
    for (const offset of [-300_001, 300_001]) {
      await expect(recordEtsyDelivery(db, raw(), new Headers(), async () => ({
        deliveryId: "fixture", timestamp: now.getTime() + offset,
      }), now)).rejects.toMatchObject({ status: 401 });
    }
    const unknown = new TextEncoder().encode(JSON.stringify({
      event_type: "listing.updated", shop_id: 999, resource_url: "https://api.etsy.com/v3/application/listings/123",
    }));
    await expect(recordEtsyDelivery(db, unknown, new Headers(), trustedFixture(), now)).rejects.toMatchObject({ status: 403 });
  });

  it.each([
    "http://api.etsy.com/v3/application/listings/123",
    "https://api.etsy.com.attacker.invalid/v3/application/listings/123",
    "******api.etsy.com/v3/application/listings/123",
    "https://api.etsy.com:8443/v3/application/listings/123",
    "https://127.0.0.1/v3/application/listings/123",
    "https://api.etsy.com/v3/application/listings/123?next=https://evil.invalid",
    "https://api.etsy.com/v3/application/listings/123#fragment",
    "https://api.etsy.com/v3/application/shops/43/receipts/123",
    "https://api.etsy.com/v3/application/listings/1/../123",
    "https://api.etsy.com/v3/application/listings/%31%32%33",
    "https://api.etsy.com/v3/application/listings/123/inventory",
  ])("rejects untrusted resource %s", (url) => {
    expect(() => parseEtsyResourceUrl(url, "42")).toThrow();
  });

  it("persists one sanitized inbox entry, including while automation is paused", async () => {
    await client.query("UPDATE shops SET kill_switch = true WHERE id = $1", [shopId]);
    const first = await recordEtsyDelivery(db, raw(), new Headers(), trustedFixture(), now);
    const duplicate = await recordEtsyDelivery(db, raw(), new Headers(), trustedFixture(), now);
    expect(first).toEqual({ accepted: true, duplicate: false });
    expect(duplicate).toEqual({ accepted: true, duplicate: true });
    const rows = await db.select().from(etsyEvents);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain("must-not-be-stored");
    expect(rows[0].shopId).toBe(shopId);
  });
});

describe("durable Etsy queue recovery", () => {
  it("recovers failed sends after restart and deduplicates send-before-ack crashes", async () => {
    const event = await insertEvent();
    const queue = queueMock();
    queue.send.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(dispatchEtsyEvents(db, queue as unknown as EtsyQueue, 10, now)).rejects.toThrow();
    expect((await db.select().from(etsyEvents))[0].dispatchedAt).toBeNull();
    await dispatchEtsyEvents(db, queue as unknown as EtsyQueue, 10, now);
    await db.update(etsyEvents).set({ dispatchedAt: null }).where(eq(etsyEvents.id, event.id));
    await dispatchEtsyEvents(db, queue as unknown as EtsyQueue, 10, now);
    expect(queue.send.mock.calls.map((c) => c[2].id)).toEqual([event.queueId, event.queueId, event.queueId]);
    expect((await queue.fetch())[0].data.eventId).toBe(event.id);
    expect(await queue.fetch()).toHaveLength(0);
  });

  it("recovers an expired claim without allowing the stale worker to erase new state", async () => {
    const event = await insertEvent();
    await db.update(etsyEvents).set({
      status: "processing", attempts: 1, leaseUntil: new Date(now.getTime() - 1), claimToken: randomUUID(),
    }).where(eq(etsyEvents.id, event.id));
    const queue = queueMock();
    await dispatchEtsyEvents(db, queue as unknown as EtsyQueue, 10, now);
    const recovered = (await db.select().from(etsyEvents))[0];
    expect(recovered).toMatchObject({ status: "pending", attempts: 1, claimToken: null });
    expect(recovered.queueId).not.toBe(event.queueId);
    expect(queue.send).toHaveBeenCalledTimes(1);
  });

  it("keeps a recovered success when the old crashed worker resumes and fails", async () => {
    const event = await insertEvent();
    let started!: () => void;
    let release!: () => void;
    const firstStarted = new Promise<void>((resolve) => { started = resolve; });
    const resumed = new Promise<void>((resolve) => { release = resolve; });
    const stale = processEtsyEvent(db, event.id, async () => {
      started();
      await resumed;
      throw new Error("stale worker failure");
    }, now);
    await firstStarted;
    const recoveredAt = new Date(now.getTime() + 301_000);
    await dispatchEtsyEvents(db, queueMock() as unknown as EtsyQueue, 10, recoveredAt);
    expect(await processEtsyEvent(db, event.id, async () => {}, recoveredAt)).toBe("completed");
    release();
    await stale;
    expect((await db.select().from(etsyEvents))[0]).toMatchObject({ status: "completed", errorCode: null });
  });

  it("retains failures, dead-letters after bounded retries, and replays only the owning shop", async () => {
    const event = await insertEvent();
    const fail = vi.fn(async () => { throw new Error("buyer personal info must not persist"); });
    for (let i = 0; i < ETSY_EVENT_MAX_ATTEMPTS; i++) {
      const result = await processEtsyEvent(db, event.id, fail, new Date(now.getTime() + i * 3_600_000));
      expect(result).toBe(i === ETSY_EVENT_MAX_ATTEMPTS - 1 ? "dead_letter" : "retry");
    }
    let stored = (await db.select().from(etsyEvents))[0];
    expect(stored).toMatchObject({ status: "dead_letter", attempts: 5, errorCode: "retries_exhausted" });
    expect(JSON.stringify(stored)).not.toContain("buyer personal");
    expect(await replayEtsyEvent(db, event.id, randomUUID(), now)).toBe(false);
    expect(await replayEtsyEvent(db, event.id, shopId, now)).toBe(true);
    const succeed = vi.fn(async () => {});
    expect(await processEtsyEvent(db, event.id, succeed, now)).toBe("completed");
    expect(await processEtsyEvent(db, event.id, succeed, now)).toBe("skipped");
    expect(await replayEtsyEvent(db, event.id, shopId, now)).toBe(false);
    expect(succeed).toHaveBeenCalledTimes(1);
    stored = (await db.select().from(etsyEvents))[0];
    expect(stored.status).toBe("completed");
  });

  it("pauses processing without losing delivery or exhausting attempts", async () => {
    const event = await insertEvent();
    mocks.getSetting.mockResolvedValue({ killSwitch: true });
    const reconcile = vi.fn(async () => {});
    expect(await processEtsyEvent(db, event.id, reconcile, now)).toBe("paused");
    expect(reconcile).not.toHaveBeenCalled();
    expect((await db.select().from(etsyEvents))[0]).toMatchObject({ status: "pending", attempts: 0, errorCode: "automation_paused" });
  });

  it("drains a bounded batch and completes idempotently", async () => {
    await insertEvent();
    const queue = queueMock();
    const reconcile = vi.fn(async () => {});
    const result = await drainEtsyEvents(db, queue as unknown as EtsyQueue, 1, reconcile);
    expect(result.completed).toBe(1);
    expect(queue.fetch).toHaveBeenCalledTimes(1);
    expect(queue.complete).toHaveBeenCalledTimes(1);
  });

  it("executes real pg-boss send/fetch/complete and retains its queue across process restarts", async () => {
    const event = await insertEvent();
    const options = { db: fromPglite(client), backend: "pglite" as const, schedule: false, supervise: false };
    let boss = new PgBoss(options);
    boss.on("error", () => {});
    try {
      await boss.start();
      await boss.createQueue(ETSY_DEAD_LETTER_QUEUE);
      await boss.createQueue(ETSY_EVENT_QUEUE, { retryLimit: 0, deadLetter: ETSY_DEAD_LETTER_QUEUE });
      await dispatchEtsyEvents(db, boss, 1, now);
      await boss.stop();
      boss = new PgBoss(options);
      boss.on("error", () => {});
      await boss.start();
      const reconcile = vi.fn(async () => {});
      const result = await drainEtsyEvents(db, boss, 1, reconcile);
      expect(result.completed).toBe(1);
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect((await db.select().from(etsyEvents).where(eq(etsyEvents.id, event.id)))[0].status).toBe("completed");
    } finally {
      await boss.stop();
    }
  }, 30_000);

  it("requires cron authentication even when disabled, and a real TCP queue URL", async () => {
    vi.stubEnv("CRON_SECRET", "unit-cron-secret");
    vi.stubEnv("ETSY_EVENTS_ENABLED", "");
    expect((await GET(new Request("http://localhost/api/cron/etsy-events"))).status).toBe(401);
    const allowed = await GET(new Request("http://localhost/api/cron/etsy-events", {
      headers: { authorization: ["Bearer", "unit-cron-secret"].join(" ") },
    }));
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ enabled: false });
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("ETSY_QUEUE_DATABASE_URL", "https://example.invalid/db");
    expect(() => etsyQueueDatabaseUrl()).toThrow("TCP Postgres");
    vi.stubEnv("ETSY_QUEUE_DATABASE_URL", "postgresql://queue.example.invalid/database");
    expect(etsyQueueDatabaseUrl()).toBe("postgresql://queue.example.invalid/database");
  });
});

describe("source-of-truth reconciliation", () => {
  let listingId: number;
  beforeAll(async () => {
    const result = await client.query<{ id: number }>(`
      INSERT INTO listings (shop_id,niche,product_type,title,tags,description,image_url,price_chf,net_chf,margin_pct,status,etsy_listing_id)
      VALUES ($1,'alpine','pod','Webhook observation','[]','test','/test.png',20,5,25,'pending_approval','123') RETURNING id`, [shopId]);
    listingId = result.rows[0].id;
  });

  it("re-fetches on out-of-order events without activating unpublished rows or overwriting inventory", async () => {
    const event = await insertEvent();
    const getListing = vi.fn().mockResolvedValueOnce({ listingId: "123", shopId: "42", state: "active", quantity: 7 })
      .mockResolvedValueOnce({ listingId: "123", shopId: "42", state: "sold_out", quantity: 0 });
    const adapter = { mode: "live", getListing, activateListing: vi.fn(), updateInventory: vi.fn() };
    mocks.getEtsyAdapter.mockResolvedValue(adapter);
    await reconcileEtsyEvent(db, event);
    await reconcileEtsyEvent(db, { ...event, eventType: "listing.created" });
    expect(getListing).toHaveBeenCalledTimes(2);
    expect(mocks.getEtsyAdapter).toHaveBeenCalledWith(db, undefined, "read", shopId);
    expect((await db.select().from(etsyListingObservations))[0]).toMatchObject({ state: "sold_out", quantity: 0 });
    const local = (await db.select().from(schema.listings).where(eq(schema.listings.id, listingId)))[0];
    expect(local.status).toBe("pending_approval");
    expect(local.activatedAt).toBeNull();
    expect(adapter.activateListing).not.toHaveBeenCalled();
    expect(adapter.updateInventory).not.toHaveBeenCalled();
  });

  it("uses one idempotent shared receipt persistence path, with no supplier calls", async () => {
    const event = await insertEvent();
    const receipts = [{ receiptId: "456-789", etsyListingId: "123", paid: true }];
    const getReceipt = vi.fn(async () => receipts);
    mocks.getEtsyAdapter.mockResolvedValue({ mode: "live", getReceipt });
    await reconcileEtsyEvent(db, { ...event, resourceType: "receipt", resourceId: "456" });
    expect(getReceipt).toHaveBeenCalledWith("456");
    expect(mocks.saveReceipts).toHaveBeenCalledWith(db, receipts, expect.any(Map), expect.objectContaining({ shopId, isDemo: false }));
  });

  it("fences a delayed old network response after a newer reconciliation succeeds", async () => {
    const event = await insertEvent();
    let release!: (snapshot: { listingId: string; shopId: string; state: string; quantity: number }) => void;
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => { started = resolve; });
    const delayed = new Promise<{ listingId: string; shopId: string; state: string; quantity: number }>((resolve) => { release = resolve; });
    const getListing = vi.fn().mockImplementationOnce(() => { started(); return delayed; })
      .mockResolvedValueOnce({ listingId: "123", shopId: "42", state: "sold_out", quantity: 0 });
    mocks.getEtsyAdapter.mockResolvedValue({ mode: "live", getListing });
    const older = reconcileEtsyEvent(db, event);
    await firstStarted;
    await reconcileEtsyEvent(db, event);
    release({ listingId: "123", shopId: "42", state: "active", quantity: 99 });
    await older;
    expect((await db.select().from(etsyListingObservations))[0]).toMatchObject({ state: "sold_out", quantity: 0 });
  });

  it("rejects cross-shop remote listing state and ignores older remote revisions", async () => {
    const event = await insertEvent();
    const getListing = vi.fn()
      .mockResolvedValueOnce({ listingId: "123", shopId: "43", state: "active", quantity: 1 })
      .mockResolvedValueOnce({ listingId: "123", shopId: "42", state: "sold_out", quantity: 0, updatedAt: now })
      .mockResolvedValueOnce({ listingId: "123", shopId: "42", state: "active", quantity: 99, updatedAt: new Date(now.getTime() - 1000) });
    mocks.getEtsyAdapter.mockResolvedValue({ mode: "live", getListing });
    await expect(reconcileEtsyEvent(db, event)).rejects.toThrow("ownership mismatch");
    await reconcileEtsyEvent(db, event);
    await reconcileEtsyEvent(db, event);
    expect((await db.select().from(etsyListingObservations))[0]).toMatchObject({ state: "sold_out", quantity: 0, remoteUpdatedAt: now });
  });
});

describe("authenticated operator reconciliation while webhooks remain disabled", () => {
  function request(body: unknown, id = "33333333-3333-4333-8333-333333333333", authenticated = true) {
    return new Request("http://localhost/api/cron/etsy-events", {
      method: "POST", headers: {
        "content-type": "application/json",
        "idempotency-key": id,
        ...(authenticated ? { authorization: ["Bearer", "unit-cron-secret"].join(" ") } : {}),
      }, body: JSON.stringify(body),
    });
  }
  const input = { shopId, resourceType: "receipt", resourceId: "456" };

  beforeEach(() => {
    vi.stubEnv("CRON_SECRET", "unit-cron-secret");
    vi.stubEnv("ETSY_EVENTS_ENABLED", "true");
    vi.stubEnv("ETSY_WEBHOOK_ENABLED", "");
  });

  it("requires cron authentication and explicit processing opt-in", async () => {
    expect((await operatorPost(request(input, undefined, false))).status).toBe(401);
    expect(mocks.getDb).not.toHaveBeenCalled();
    vi.stubEnv("ETSY_EVENTS_ENABLED", "");
    expect((await operatorPost(request(input))).status).toBe(503);
    expect(await db.select().from(etsyEvents)).toHaveLength(0);
  });

  it("queues an explicitly operator-sourced request durably without verifying a webhook or starting a worker", async () => {
    const first = await operatorPost(request(input));
    const duplicate = await operatorPost(request(input));
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ source: "operator", status: "pending", duplicate: false });
    expect(await duplicate.json()).toMatchObject({ source: "operator", duplicate: true });
    const rows = await db.select().from(etsyEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "operator", eventType: "operator.reconcile", resourceType: "receipt", resourceId: "456", dispatchedAt: null });
    expect(mocks.getEtsyAdapter).not.toHaveBeenCalled();
    const queue = queueMock();
    const reconcile = vi.fn(async () => {});
    expect((await drainEtsyEvents(db, queue as unknown as EtsyQueue, 1, reconcile)).completed).toBe(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("rejects reused keys with changed intent, unowned resources, raw URLs, missing keys and oversized bodies", async () => {
    expect((await operatorPost(request(input))).status).toBe(202);
    expect((await operatorPost(request({ ...input, resourceId: "457" }))).status).toBe(409);
    expect((await operatorPost(request(input, ""))).status).toBe(400);
    expect((await operatorPost(request({ ...input, resourceType: "listing", resourceId: "999" }))).status).toBe(403);
    expect((await operatorPost(request({ ...input, resource_url: "https://evil.invalid" }))).status).toBe(400);
    expect((await operatorPost(request({ ...input, shopId: randomUUID() }))).status).toBe(404);
    expect((await operatorPost(request({ ...input, resourceId: "x".repeat(2000) }))).status).toBe(413);
  });
});
