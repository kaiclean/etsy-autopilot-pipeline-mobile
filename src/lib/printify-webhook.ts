import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import { listings, orders, printifyEvents, type FulfillmentStatus } from "@/db/schema";
import { config } from "@/lib/config";
import { linkUnmatchedOrders } from "@/pipeline/etsy-id-sync";

const REDACT = new Set(["email", "phone", "first_name", "last_name", "address1", "address2", "address_to"]);

const FULFILLMENT_RANK: Record<string, number> = {
  pending: 1,
  in_production: 2,
  shipped: 3,
  delivered: 4,
};

export type PrintifyMapping = {
  eventId: string;
  topic: string;
  printifyProductId?: string;
  printifyOrderId?: string;
  etsyListingId?: string;
  etsyOrderId?: string;
  fulfillment?: FulfillmentStatus;
};

export type PrintifyIngestResult = PrintifyMapping & {
  duplicate: boolean;
  verified: boolean;
  listingUpdated: boolean;
  orderUpdated: boolean;
};

type Rec = Record<string, unknown>;

function asRecord(value: unknown): Rec {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : {};
}

function str(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

export function printifySignature(secret: string, rawBody: string) {
  return `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
}

/** Constant-time check of Printify's `x-pfy-signature` header (`sha256=<hex>`). */
export function verifyPrintifySignature(secret: string, rawBody: string, header: string | null) {
  if (!header) return false;
  const expected = Buffer.from(printifySignature(secret, rawBody));
  const got = Buffer.from(header.trim());
  if (expected.length !== got.length) return false;
  return timingSafeEqual(expected, got);
}

export type WebhookAuth = "verified" | "unsigned-dev" | "missing-secret" | "bad-signature";

/**
 * Production refuses unsigned deliveries. Local and test runs can store them
 * with verified=false so the dry-run dashboard can be exercised without a secret.
 */
export function authorizePrintifyWebhook(rawBody: string, signature: string | null, nodeEnv = process.env.NODE_ENV): WebhookAuth {
  const secret = config.printify.webhookSecret;
  if (secret) return verifyPrintifySignature(secret, rawBody, signature) ? "verified" : "bad-signature";
  if (nodeEnv === "production") return "missing-secret";
  return "unsigned-dev";
}

export function redactWebhookPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactWebhookPayload);
  if (!value || typeof value !== "object") return value;
  const out: Rec = {};
  for (const [key, child] of Object.entries(value as Rec)) {
    if (REDACT.has(key)) continue;
    out[key] = redactWebhookPayload(child);
  }
  return out;
}

export function fulfillmentFromTopic(topic: string, status?: string): FulfillmentStatus | undefined {
  if (topic === "order:shipment:delivered") return "delivered";
  if (topic === "order:shipment:created") return "shipped";
  if (topic === "order:sent-to-production") return "in_production";
  const normalized = (status ?? "").toLowerCase().replace(/_/g, "-");
  if (normalized === "fulfilled" || normalized === "delivered") return "delivered";
  if (normalized === "shipped" || normalized === "partially-fulfilled") return "shipped";
  if (normalized === "in-production" || normalized === "sending-to-production") return "in_production";
  if (topic === "order:created" || normalized === "pending" || normalized === "on-hold") return "pending";
  return undefined;
}

function advanceFulfillment(current: string, incoming: FulfillmentStatus | undefined) {
  if (!incoming || current === "delivered_digital") return undefined;
  if ((FULFILLMENT_RANK[incoming] ?? 0) > (FULFILLMENT_RANK[current] ?? 0)) return incoming;
  return undefined;
}

/** Fill an empty or dry-run id. Never replace a real id with a different one. */
export function shouldFillExternalId(current: string | null | undefined, incoming: string | undefined) {
  if (!incoming) return false;
  if (!current) return true;
  if (current === incoming) return false;
  return current.startsWith("dry-");
}

export function extractPrintifyMapping(payload: unknown, rawBody: string): PrintifyMapping {
  const root = asRecord(payload);
  const resource = asRecord(root.resource);
  const data = asRecord(resource.data);
  const external = asRecord(data.external);
  const metadata = asRecord(data.metadata);
  const topic = str(root.type) ?? str(root.topic) ?? "unknown";
  const resourceType = str(resource.type);
  const resourceId = str(resource.id) ?? str(data.id);
  const eventId = str(root.id) ?? str(root.event_id) ?? `body:${createHash("sha256").update(rawBody).digest("hex")}`;

  let printifyProductId = str(data.product_id);
  let printifyOrderId = str(data.order_id);
  if (resourceType === "product" || topic.startsWith("product:")) printifyProductId ??= resourceId;
  if (resourceType === "order" || topic.startsWith("order:")) printifyOrderId ??= resourceId;

  let etsyListingId = str(external.id) ?? str(data.etsy_listing_id);
  let etsyOrderId = str(data.etsy_order_id) ?? str(data.etsy_receipt_id) ?? str(metadata.shop_order_id) ?? str(metadata.shop_order_label);

  if (topic.startsWith("order:")) etsyOrderId ??= str(data.external_id);
  else etsyListingId ??= str(data.external_id);

  const lineItems = Array.isArray(data.line_items) ? data.line_items : [];
  for (const item of lineItems) {
    const line = asRecord(item);
    const lineMeta = asRecord(line.metadata);
    printifyProductId ??= str(line.product_id);
    etsyListingId ??= str(lineMeta.external_id) ?? str(line.external_id);
  }

  return {
    eventId,
    topic,
    printifyProductId,
    printifyOrderId,
    etsyListingId,
    etsyOrderId,
    fulfillment: fulfillmentFromTopic(topic, str(data.status)),
  };
}

/**
 * Store the delivery once and, when ids match local rows, write the Etsy listing id
 * and Printify order id. No Printify or Etsy API calls — safe while PUBLISH_MODE=dry-run.
 */
export async function ingestPrintifyWebhook(
  db: DB,
  input: { rawBody: string; payload: unknown; verified: boolean },
): Promise<PrintifyIngestResult> {
  const mapping = extractPrintifyMapping(input.payload, input.rawBody);
  const payload = redactWebhookPayload(input.payload);
  const inserted = await db
    .insert(printifyEvents)
    .values({
      eventId: mapping.eventId,
      topic: mapping.topic,
      printifyProductId: mapping.printifyProductId,
      printifyOrderId: mapping.printifyOrderId,
      etsyListingId: mapping.etsyListingId,
      etsyOrderId: mapping.etsyOrderId,
      verified: input.verified,
      payload: (payload && typeof payload === "object" ? payload : { value: payload }) as Record<string, unknown>,
    })
    .onConflictDoNothing({ target: printifyEvents.eventId })
    .returning({ id: printifyEvents.id });
  const duplicate = inserted.length === 0;

  let listingId: number | undefined;
  let listingUpdated = false;
  if (mapping.printifyProductId) {
    const [listing] = await db.select().from(listings).where(eq(listings.printifyProductId, mapping.printifyProductId)).limit(1);
    if (listing) {
      listingId = listing.id;
      const incoming = mapping.etsyListingId;
      const fill = shouldFillExternalId(listing.etsyListingId, incoming);
      const awaitingId = listing.status === "publishing" || listing.status === "pod_created";
      const now = new Date();
      if (fill || (incoming && awaitingId && listing.etsyListingId === incoming)) {
        await db
          .update(listings)
          .set({
            etsyListingId: incoming,
            ...(awaitingId && incoming ? { status: "published" as const, publishError: null, publishedAt: listing.publishedAt ?? now } : {}),
            updatedAt: now,
          })
          .where(eq(listings.id, listing.id));
        listingUpdated = true;
      }
      if (incoming && (fill || listing.etsyListingId === incoming)) {
        await linkUnmatchedOrders(db, listing, incoming, now);
      }
    }
  }

  let orderId: number | undefined;
  let orderUpdated = false;
  if (mapping.printifyOrderId || mapping.etsyOrderId) {
    const [byPod] = mapping.printifyOrderId
      ? await db.select().from(orders).where(eq(orders.podOrderId, mapping.printifyOrderId)).limit(1)
      : [];
    const [byReceipt] = !byPod && mapping.etsyOrderId
      ? await db.select().from(orders).where(eq(orders.etsyReceiptId, mapping.etsyOrderId)).limit(1)
      : [];
    const order = byPod ?? byReceipt;
    if (order) {
      orderId = order.id;
      const nextStatus = advanceFulfillment(order.fulfillmentStatus, mapping.fulfillment);
      const nextPod = shouldFillExternalId(order.podOrderId, mapping.printifyOrderId) ? mapping.printifyOrderId : undefined;
      if (nextStatus || nextPod) {
        await db
          .update(orders)
          .set({
            ...(nextStatus ? { fulfillmentStatus: nextStatus } : {}),
            ...(nextPod ? { podOrderId: nextPod } : {}),
            updatedAt: new Date(),
          })
          .where(eq(orders.id, order.id));
        orderUpdated = true;
      }
    }
  }

  if (!duplicate && (listingId || orderId)) {
    await db
      .update(printifyEvents)
      .set({ ...(listingId ? { listingId } : {}), ...(orderId ? { orderId } : {}) })
      .where(eq(printifyEvents.eventId, mapping.eventId));
  }

  console.info(
    `[printify-webhook] ${mapping.topic} product=${mapping.printifyProductId ?? "-"} order=${mapping.printifyOrderId ?? "-"} etsyListing=${mapping.etsyListingId ?? "-"} duplicate=${duplicate} publishMode=${config.publishMode}`,
  );

  return { ...mapping, duplicate, verified: input.verified, listingUpdated, orderUpdated };
}
