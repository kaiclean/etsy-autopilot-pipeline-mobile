import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import { pushSubscriptions } from "@/db/schema";
import type { EmitInput } from "@/lib/events";
import { config, vapidConfigured } from "@/lib/config";
import { pushEventEnabled } from "@/lib/push-prefs";
import { getSetting } from "@/lib/settings";

/** Events that should reach a closed PWA. In-app toasts still cover everything else. */
export const PUSH_EVENT_TYPES = new Set(["order.new", "approval.pending", "job.failed", "listing.failed", "listing.awaiting_etsy_id"]);

export type PushPayload = { title: string; body: string; url: string };

export type PushSubscriptionKeys = { endpoint: string; keys: { p256dh: string; auth: string } };

export type PushSender = (subscription: PushSubscriptionKeys, payload: string) => Promise<void>;

export type PushDispatchResult = { sent: number; removed: number; skipped?: "type" | "unconfigured" | "empty" | "pref" };

let vapidReady = false;

function statusCodeOf(error: unknown) {
  if (!error || typeof error !== "object" || !("statusCode" in error)) return undefined;
  const code = (error as { statusCode?: unknown }).statusCode;
  return typeof code === "number" ? code : undefined;
}

async function defaultSender(subscription: PushSubscriptionKeys, payload: string) {
  const webpush = await import("web-push");
  const send = webpush.default?.sendNotification ?? webpush.sendNotification;
  const setVapid = webpush.default?.setVapidDetails ?? webpush.setVapidDetails;
  if (!vapidReady) {
    const v = config.vapid;
    setVapid(v.subject!, v.publicKey!, v.privateKey!);
    vapidReady = true;
  }
  await send(subscription, payload);
}

export function pushPayload(event: Pick<EmitInput, "title" | "body" | "href">): PushPayload {
  return {
    title: event.title,
    body: event.body ?? "",
    url: event.href || "/",
  };
}

export async function savePushSubscription(
  db: DB,
  input: { endpoint: string; p256dh: string; auth: string; userAgent?: string | null },
) {
  const now = new Date();
  await db
    .insert(pushSubscriptions)
    .values({
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      userAgent: input.userAgent?.slice(0, 300) ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { p256dh: input.p256dh, auth: input.auth, userAgent: input.userAgent?.slice(0, 300) ?? null, updatedAt: now },
    });
}

export async function deletePushSubscription(db: DB, endpoint: string) {
  await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
}

export function validPushEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== "string" || endpoint.length < 12 || endpoint.length > 2048) return false;
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

async function deliver(db: DB, payload: PushPayload, sender: PushSender): Promise<PushDispatchResult> {
  const subs = await db.select().from(pushSubscriptions);
  if (subs.length === 0) return { sent: 0, removed: 0, skipped: "empty" };
  const body = JSON.stringify(payload);
  let sent = 0;
  let removed = 0;
  for (const sub of subs) {
    const subscription = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
    try {
      await sender(subscription, body);
      sent++;
    } catch (error) {
      const status = statusCodeOf(error);
      if (status === 404 || status === 410) {
        await deletePushSubscription(db, sub.endpoint);
        removed++;
      } else {
        console.error("[web-push] delivery failed", status ?? (error instanceof Error ? error.message : "unknown"));
      }
    }
  }
  return { sent, removed };
}

/** Fan-out for pipeline events. No-op until VAPID is configured, so dry-run stays quiet. */
export async function dispatchEventPush(db: DB, event: EmitInput, sender: PushSender = defaultSender): Promise<PushDispatchResult> {
  if (!PUSH_EVENT_TYPES.has(event.type)) return { sent: 0, removed: 0, skipped: "type" };
  if (!vapidConfigured()) return { sent: 0, removed: 0, skipped: "unconfigured" };
  const prefs = await getSetting(db, "pushPrefs");
  if (!pushEventEnabled(prefs, event.type)) return { sent: 0, removed: 0, skipped: "pref" };
  return deliver(db, pushPayload(event), sender);
}

export async function sendTestPush(db: DB, sender: PushSender = defaultSender): Promise<PushDispatchResult> {
  if (!vapidConfigured()) return { sent: 0, removed: 0, skipped: "unconfigured" };
  return deliver(
    db,
    { title: "Etsy Autopilot", body: "Test push. Sales and approvals will show up like this.", url: "/settings" },
    sender,
  );
}
