import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import { etsyEvents } from "@/db/etsy-events";
import { shops } from "@/db/schema";

export const ETSY_WEBHOOK_MAX_BYTES = 64 * 1024;
export const ETSY_REPLAY_TOLERANCE_MS = 5 * 60 * 1000;

export class EtsyWebhookError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export type VerifiedEtsyDelivery = { deliveryId: string; timestamp: number };
export type EtsySignatureVerifier = (raw: Uint8Array, headers: Headers) => Promise<VerifiedEtsyDelivery>;

/**
 * Etsy webhook signature verification.
 * Etsy sends HMAC-SHA256 of the raw body in the X-Etsy-Signature header.
 * The signature is base64-encoded: "sha256=<base64_hmac>"
 * We verify using the app's ETSY_SHARED_SECRET.
 */
export const verifyEtsyWebhook: EtsySignatureVerifier = async (raw, headers) => {
  const signatureHeader = headers.get("x-etsy-signature") ?? headers.get("X-Etsy-Signature");
  if (!signatureHeader) throw new EtsyWebhookError(401, "Missing X-Etsy-Signature header");
  
  const match = signatureHeader.match(/^sha256=([A-Za-z0-9+/=]+)$/);
  if (!match) throw new EtsyWebhookError(401, "Invalid signature format (expected sha256=<base64>)");
  
  const expectedSignature = match[1];
  const sharedSecret = process.env.ETSY_SHARED_SECRET;
  if (!sharedSecret) throw new EtsyWebhookError(500, "ETSY_SHARED_SECRET not configured");
  
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(sharedSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, raw as unknown as BufferSource);
  const actualSignature = btoa(String.fromCharCode(...new Uint8Array(signature)));
  
  // Constant-time comparison
  if (expectedSignature.length !== actualSignature.length) {
    throw new EtsyWebhookError(401, "Signature mismatch");
  }
  let diff = 0;
  for (let i = 0; i < expectedSignature.length; i++) {
    diff |= expectedSignature.charCodeAt(i) ^ actualSignature.charCodeAt(i);
  }
  if (diff !== 0) throw new EtsyWebhookError(401, "Signature mismatch");
  
  // Etsy includes a delivery ID in X-Etsy-Delivery-Id or similar
  const deliveryId = headers.get("x-etsy-delivery-id") ?? headers.get("X-Etsy-Delivery-Id") ?? 
    headers.get("x-etsy-webhook-id") ?? headers.get("X-Etsy-Webhook-Id") ?? "";
  
  // Timestamp from X-Etsy-Delivery-Timestamp or X-Etsy-Event-Time
  const tsHeader = headers.get("x-etsy-delivery-timestamp") ?? headers.get("X-Etsy-Delivery-Timestamp") ??
    headers.get("x-etsy-event-time") ?? headers.get("X-Etsy-Event-Time") ?? "";
  const timestamp = tsHeader ? Number(tsHeader) : Date.now();
  
  if (!Number.isFinite(timestamp)) {
    throw new EtsyWebhookError(401, "Invalid timestamp");
  }
  
  return { deliveryId: deliveryId || `unknown-${Date.now()}`, timestamp };
};

export function etsyWebhookEnabled() {
  return process.env.ETSY_WEBHOOK_ENABLED === "true";
}

export async function readEtsyWebhookBody(request: Request, maxBytes = ETSY_WEBHOOK_MAX_BYTES) {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    throw new EtsyWebhookError(413, "Request body too large");
  }
  if (!request.body) throw new EtsyWebhookError(400, "Webhook body missing");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => {});
  }, 10_000);
  try {
    while (true) {
      const chunk = await reader.read();
      if (timedOut) throw new EtsyWebhookError(408, "Webhook body read timed out");
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new EtsyWebhookError(413, "Request body too large");
      }
      chunks.push(chunk.value);
    }
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
  const raw = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    raw.set(chunk, offset);
    offset += chunk.length;
  }
  return raw;
}

function numericId(value: unknown): string {
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new EtsyWebhookError(400, "Invalid identifier");
  const id = String(value ?? "");
  if (!/^[1-9]\d{0,18}$/.test(id)) throw new EtsyWebhookError(400, "Invalid identifier");
  return id;
}

/** Never fetch the supplied URL. Extract an id and use the adapter's fixed API origin. */
export function parseEtsyResourceUrl(value: unknown, shopId: string) {
  if (typeof value !== "string" || value.length > 512) throw new EtsyWebhookError(400, "Invalid resource URL");
  let url: URL;
  try { url = new URL(value); } catch { throw new EtsyWebhookError(400, "Invalid resource URL"); }
  if (
    url.protocol !== "https:" || !["openapi.etsy.com", "api.etsy.com"].includes(url.hostname) ||
    url.port || url.username || url.password || url.search || url.hash ||
    value.includes("%") || value.includes("\\") || value.includes("/../") || value.includes("/./")
  ) throw new EtsyWebhookError(400, "Untrusted resource URL");
  const receipt = url.pathname.match(/^\/v3\/application\/shops\/([1-9]\d{0,18})\/receipts\/([1-9]\d{0,18})$/);
  if (receipt && receipt[1] === shopId) return { resourceType: "receipt" as const, resourceId: receipt[2] };
  const listing = url.pathname.match(/^\/v3\/application\/listings\/([1-9]\d{0,18})$/);
  if (listing) return { resourceType: "listing" as const, resourceId: listing[1] };
  throw new EtsyWebhookError(400, "Resource path is not allowed for this shop");
}

export function parseEtsyEnvelope(raw: Uint8Array) {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch { throw new EtsyWebhookError(400, "Invalid webhook JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new EtsyWebhookError(400, "Invalid webhook envelope");
  const etsyShopId = numericId(value.shop_id);
  if (typeof value.event_type !== "string" || !/^[a-z][a-z0-9_.-]{0,99}$/.test(value.event_type)) {
    throw new EtsyWebhookError(400, "Invalid event type");
  }
  const resource = parseEtsyResourceUrl(value.resource_url, etsyShopId);
  if (value.listing_id != null && (resource.resourceType !== "listing" || numericId(value.listing_id) !== resource.resourceId)) {
    throw new EtsyWebhookError(400, "Mismatched listing identifier");
  }
  return { etsyShopId, eventType: value.event_type, ...resource };
}

/** The verifier is an internal integration seam, never selected by request data or environment. */
export async function recordEtsyDelivery(
  db: DB,
  raw: Uint8Array,
  headers: Headers,
  verifier: EtsySignatureVerifier = verifyEtsyWebhook,
  now = new Date(),
) {
  if (raw.length > ETSY_WEBHOOK_MAX_BYTES) throw new EtsyWebhookError(413, "Webhook body too large");
  const verified = await verifier(raw, headers);
  if (!verified.deliveryId || verified.deliveryId.length > 256 || !Number.isFinite(verified.timestamp) ||
    Math.abs(now.getTime() - verified.timestamp) > ETSY_REPLAY_TOLERANCE_MS) {
    throw new EtsyWebhookError(401, "Invalid or expired delivery");
  }
  const envelope = parseEtsyEnvelope(raw);
  const [shop] = await db.select({ id: shops.id }).from(shops).where(eq(shops.etsyShopId, envelope.etsyShopId));
  if (!shop) throw new EtsyWebhookError(403, "Shop is not registered");
  const deliveryKey = createHash("sha256").update(`${envelope.etsyShopId}:${verified.deliveryId}`).digest("hex");
  const [inserted] = await db.insert(etsyEvents).values({
    deliveryKey, shopId: shop.id, ...envelope, receivedAt: now, nextAttemptAt: now,
  }).onConflictDoNothing({ target: etsyEvents.deliveryKey }).returning({ id: etsyEvents.id });
  return { accepted: true, duplicate: !inserted };
}
