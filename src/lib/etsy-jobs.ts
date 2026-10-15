import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { PgBoss, type Job } from "pg-boss";
import type { DB } from "@/db";
import { etsyEvents, type EtsyInboxEvent } from "@/db/etsy-events";
import { listings, shops } from "@/db/schema";
import { getSetting } from "@/lib/settings";
import { reconcileEtsyEvent } from "@/pipeline/etsy-reconcile";

export const ETSY_EVENT_QUEUE = "etsy-events";
export const ETSY_DEAD_LETTER_QUEUE = "etsy-events-dead-letter";
export const ETSY_EVENT_MAX_ATTEMPTS = 5;
const LEASE_MS = 5 * 60 * 1000;
const DISPATCH_RECOVERY_MS = 10 * 60 * 1000;
type QueueData = { eventId: string };
export type EtsyQueue = Pick<PgBoss, "send" | "fetch" | "complete" | "fail">;
export type EtsyReconciler = (db: DB, event: EtsyInboxEvent) => Promise<void>;

export class EtsyProcessingPaused extends Error {}

export class EtsyReconciliationRequestError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

/** Authenticated operator intent is labeled separately; this never represents a verified webhook. */
export async function enqueueEtsyReconciliation(db: DB, input: unknown, requestId: string | null, now = new Date()) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!requestId || !uuid.test(requestId)) {
    throw new EtsyReconciliationRequestError(400, "A UUID Idempotency-Key header is required");
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new EtsyReconciliationRequestError(400, "Invalid reconciliation request");
  }
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some((key) => !["shopId", "resourceType", "resourceId"].includes(key)) ||
    typeof value.shopId !== "string" || !uuid.test(value.shopId) ||
    !["listing", "receipt"].includes(String(value.resourceType)) ||
    typeof value.resourceId !== "string" || !/^[1-9]\d{0,18}$/.test(value.resourceId)
  ) throw new EtsyReconciliationRequestError(400, "Expected shopId, resourceType and numeric resourceId; URLs are not accepted");
  const [shop] = await db.select({ id: shops.id, etsyShopId: shops.etsyShopId }).from(shops).where(eq(shops.id, value.shopId));
  if (!shop?.etsyShopId || !/^[1-9]\d{0,18}$/.test(shop.etsyShopId)) {
    throw new EtsyReconciliationRequestError(404, "Shop has no registered Etsy account");
  }
  if (value.resourceType === "listing") {
    const [owned] = await db.select({ id: listings.id }).from(listings)
      .where(and(eq(listings.shopId, shop.id), eq(listings.etsyListingId, value.resourceId)));
    if (!owned) throw new EtsyReconciliationRequestError(403, "Listing does not belong to this shop");
  }
  const deliveryKey = createHash("sha256").update(`operator:${shop.id}:${requestId.toLowerCase()}`).digest("hex");
  const [inserted] = await db.insert(etsyEvents).values({
    deliveryKey, source: "operator", eventType: "operator.reconcile", shopId: shop.id,
    etsyShopId: shop.etsyShopId, resourceType: value.resourceType as "listing" | "receipt",
    resourceId: value.resourceId, receivedAt: now, nextAttemptAt: now,
  }).onConflictDoNothing({ target: etsyEvents.deliveryKey }).returning();
  const event = inserted ?? (await db.select().from(etsyEvents).where(eq(etsyEvents.deliveryKey, deliveryKey)))[0];
  if (!event || event.source !== "operator" || event.resourceType !== value.resourceType || event.resourceId !== value.resourceId) {
    throw new EtsyReconciliationRequestError(409, "Idempotency key was already used for a different reconciliation");
  }
  return { eventId: event.id, source: "operator" as const, status: event.status, duplicate: !inserted };
}

export function etsyEventsEnabled() {
  return process.env.ETSY_EVENTS_ENABLED === "true";
}

export function etsyQueueDatabaseUrl() {
  const value = process.env.ETSY_QUEUE_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (!value) throw new Error("Etsy queue requires a TCP Postgres DATABASE_URL or ETSY_QUEUE_DATABASE_URL");
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname) {
    throw new Error("Etsy queue requires a TCP Postgres connection string");
  }
  return value;
}

export async function openEtsyQueue() {
  const boss = new PgBoss({
    connectionString: etsyQueueDatabaseUrl(), max: 2, connectionTimeoutMillis: 10_000,
    // Cron owns draining. Never register a second recurring scheduler or a web-process worker.
    schedule: false, supervise: false,
  });
  boss.on("error", () => { /* The durable inbox is recovered by the next cron invocation. */ });
  try {
    await boss.start();
    await boss.createQueue(ETSY_DEAD_LETTER_QUEUE);
    await boss.createQueue(ETSY_EVENT_QUEUE, {
      retryLimit: 0, expireInSeconds: 300, retentionSeconds: 7 * 86400,
      deadLetter: ETSY_DEAD_LETTER_QUEUE,
    });
    await boss.supervise(ETSY_EVENT_QUEUE, { reindex: false });
    await boss.supervise(ETSY_DEAD_LETTER_QUEUE, { reindex: false });
    return boss;
  } catch (error) {
    await boss.stop().catch(() => {});
    throw error;
  }
}

/** Inbox is the outbox: a send/ack crash is recovered with the same persisted queue id. */
export async function dispatchEtsyEvents(db: DB, queue: EtsyQueue, limit = 20, now = new Date()) {
  const expired = await db.select().from(etsyEvents).where(and(
    eq(etsyEvents.status, "processing"), lte(etsyEvents.leaseUntil, now),
  )).limit(limit);
  for (const event of expired) {
    await db.update(etsyEvents).set({
      status: event.attempts >= ETSY_EVENT_MAX_ATTEMPTS ? "dead_letter" : "pending",
      queueId: randomUUID(), dispatchedAt: null, leaseUntil: null, claimToken: null,
      errorCode: "worker_lease_expired", nextAttemptAt: now,
    }).where(and(eq(etsyEvents.id, event.id), eq(etsyEvents.claimToken, event.claimToken!)));
  }
  const pending = await db.select().from(etsyEvents).where(and(
    eq(etsyEvents.status, "pending"), lte(etsyEvents.nextAttemptAt, now),
    or(isNull(etsyEvents.dispatchedAt), lte(etsyEvents.dispatchedAt, new Date(now.getTime() - DISPATCH_RECOVERY_MS))),
  )).orderBy(asc(etsyEvents.receivedAt)).limit(limit);
  let dispatched = 0;
  for (const event of pending) {
    let queueId = event.queueId;
    if (event.dispatchedAt) {
      queueId = randomUUID();
      const [updated] = await db.update(etsyEvents).set({ queueId, dispatchedAt: null })
        .where(and(eq(etsyEvents.id, event.id), eq(etsyEvents.queueId, event.queueId), eq(etsyEvents.status, "pending")))
        .returning({ id: etsyEvents.id });
      if (!updated) continue;
    }
    await queue.send(ETSY_EVENT_QUEUE, { eventId: event.id }, {
      id: queueId, retryLimit: 0, expireInSeconds: 300, deadLetter: ETSY_DEAD_LETTER_QUEUE,
    });
    await db.update(etsyEvents).set({ dispatchedAt: now })
      .where(and(eq(etsyEvents.id, event.id), eq(etsyEvents.queueId, queueId), eq(etsyEvents.status, "pending")));
    dispatched++;
  }
  return dispatched;
}

export async function processEtsyEvent(
  db: DB, eventId: string, reconcile: EtsyReconciler = reconcileEtsyEvent, now = new Date(),
) {
  const claimToken = randomUUID();
  const [event] = await db.update(etsyEvents).set({
    status: "processing", claimToken, leaseUntil: new Date(now.getTime() + LEASE_MS),
    attempts: sql`${etsyEvents.attempts} + 1`,
  }).where(and(
    eq(etsyEvents.id, eventId), eq(etsyEvents.status, "pending"), lte(etsyEvents.nextAttemptAt, now),
  )).returning();
  if (!event) return "skipped" as const;
  const owned = and(eq(etsyEvents.id, event.id), eq(etsyEvents.claimToken, claimToken), eq(etsyEvents.status, "processing"));
  try {
    const [shop] = await db.select().from(shops).where(eq(shops.id, event.shopId));
    if (!shop || shop.etsyShopId !== event.etsyShopId) throw new Error("Shop ownership changed");
    const automation = await getSetting(db, "automation");
    if (automation.killSwitch || shop.killSwitch || ["paused", "archived"].includes(shop.status)) {
      throw new EtsyProcessingPaused("Automation is paused");
    }
    await reconcile(db, event);
    await db.update(etsyEvents).set({
      status: "completed", completedAt: new Date(), leaseUntil: null, claimToken: null, errorCode: null,
    }).where(owned);
    return "completed" as const;
  } catch (error) {
    const paused = error instanceof EtsyProcessingPaused;
    const terminal = !paused && event.attempts >= ETSY_EVENT_MAX_ATTEMPTS;
    await db.update(etsyEvents).set({
      status: terminal ? "dead_letter" : "pending",
      attempts: paused ? event.attempts - 1 : event.attempts,
      queueId: randomUUID(), dispatchedAt: null, leaseUntil: null, claimToken: null,
      nextAttemptAt: new Date(now.getTime() + (paused ? 60_000 : Math.min(3600, 30 * 2 ** (event.attempts - 1)) * 1000)),
      // Provider error messages can contain buyer details, URLs or credentials. Never persist them.
      errorCode: paused ? "automation_paused" : terminal ? "retries_exhausted" : "reconcile_failed",
    }).where(owned);
    return terminal ? "dead_letter" as const : paused ? "paused" as const : "retry" as const;
  }
}

/** Explicit, shop-scoped operator recovery; duplicates of successful deliveries stay completed. */
export async function replayEtsyEvent(db: DB, eventId: string, shopId: string, now = new Date()) {
  const [event] = await db.update(etsyEvents).set({
    status: "pending", attempts: 0, queueId: randomUUID(), dispatchedAt: null,
    leaseUntil: null, claimToken: null, nextAttemptAt: now, errorCode: null, completedAt: null,
  }).where(and(eq(etsyEvents.id, eventId), eq(etsyEvents.shopId, shopId), eq(etsyEvents.status, "dead_letter")))
    .returning({ id: etsyEvents.id });
  return Boolean(event);
}

export async function drainEtsyEvents(db: DB, queue: EtsyQueue, limit = 10, reconcile: EtsyReconciler = reconcileEtsyEvent) {
  const bounded = Math.max(1, Math.min(20, Math.floor(limit)));
  const dispatched = await dispatchEtsyEvents(db, queue, bounded);
  const results = { dispatched, completed: 0, retry: 0, paused: 0, dead_letter: 0, skipped: 0 };
  // Fetch one at a time, so no leased batch waits while prior network calls run.
  const deadline = Date.now() + 240_000;
  for (let i = 0; i < bounded && Date.now() < deadline; i++) {
    const [job] = await queue.fetch<QueueData>(ETSY_EVENT_QUEUE, { batchSize: 1 });
    if (!job) break;
    if (!validJob(job)) {
      await queue.fail(ETSY_EVENT_QUEUE, job, { code: "invalid_event_reference" });
      continue;
    }
    const result = await processEtsyEvent(db, job.data.eventId, reconcile);
    results[result]++;
    if (result === "dead_letter") {
      await queue.fail(ETSY_EVENT_QUEUE, job, { code: result });
    } else {
      await queue.complete(ETSY_EVENT_QUEUE, job);
    }
  }
  return results;
}

function validJob(job: Job<QueueData>) {
  return typeof job.data?.eventId === "string" && /^[0-9a-f-]{36}$/i.test(job.data.eventId);
}
