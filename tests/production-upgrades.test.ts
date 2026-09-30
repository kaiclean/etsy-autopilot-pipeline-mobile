import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { listings, orders, printifyEvents, pushSubscriptions } from "@/db/schema";
import { config, storageBackend, vapidConfigured } from "@/lib/config";
import { decodeDataUrl, isOwnStorageUrl, materializeImageUrl, type StoredObject } from "@/lib/object-storage";
import { POST as printifyWebhook } from "@/app/api/webhooks/printify/route";
import {
  authorizePrintifyWebhook,
  extractPrintifyMapping,
  ingestPrintifyWebhook,
  printifySignature,
  redactWebhookPayload,
  verifyPrintifySignature,
} from "@/lib/printify-webhook";
import { deletePushSubscription, dispatchEventPush, pushPayload, savePushSubscription, type PushSender } from "@/lib/push";

const ENV_KEYS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_ENDPOINT_URL_S3",
  "AWS_REGION",
  "S3_BUCKET",
  "S3_PUBLIC_BASE_URL",
  "S3_URL_MODE",
  "BLOB_READ_WRITE_TOKEN",
  "VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
  "VAPID_SUBJECT",
  "PRINTIFY_WEBHOOK_SECRET",
  "PUBLISH_MODE",
  "APP_URL",
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
});

describe("publish mode stays dry-run", () => {
  it("treats anything other than live as dry-run", () => {
    delete process.env.PUBLISH_MODE;
    expect(config.publishMode).toBe("dry-run");
    process.env.PUBLISH_MODE = "LIVE";
    expect(config.publishMode).toBe("dry-run");
  });
});

describe("object storage", () => {
  it("decodes a data URL and leaves it in place when storage is unset", async () => {
    const bytes = Buffer.from("png-bytes");
    const url = `data:image/png;base64,${bytes.toString("base64")}`;
    expect(decodeDataUrl(url)?.bytes.equals(bytes)).toBe(true);
    expect(decodeDataUrl(url)?.contentType).toBe("image/png");
    expect(storageBackend()).toBe("none");
    expect(await materializeImageUrl(url)).toBe(url);
    expect(await materializeImageUrl("/api/placeholder/1?niche=alpine")).toBe("/api/placeholder/1?niche=alpine");
  });

  it("prefers S3 over Blob and uploads data URLs and remote files", async () => {
    process.env.AWS_ACCESS_KEY_ID = "key";
    process.env.AWS_SECRET_ACCESS_KEY = "secret";
    process.env.AWS_ENDPOINT_URL_S3 = "https://storage.example";
    process.env.S3_BUCKET = "designs";
    process.env.BLOB_READ_WRITE_TOKEN = "blob-token";
    process.env.S3_PUBLIC_BASE_URL = "https://cdn.example";
    expect(storageBackend()).toBe("s3");

    const uploads: Array<{ bytes: Buffer; contentType: string }> = [];
    const upload = async (bytes: Buffer, contentType: string): Promise<StoredObject> => {
      uploads.push({ bytes, contentType });
      return { url: "https://cdn.example/designs/stored.png", key: "designs/2026-09-30/stored.png", backend: "s3" };
    };

    const dataUrl = `data:image/webp;base64,${Buffer.from("webp").toString("base64")}`;
    await expect(materializeImageUrl(dataUrl, { upload })).resolves.toBe("https://cdn.example/designs/stored.png");
    expect(uploads[0]?.contentType).toBe("image/webp");
    expect(uploads[0]?.bytes.toString()).toBe("webp");

    const fetchImpl = async () =>
      ({
        ok: true,
        headers: { get: () => "image/png" },
        arrayBuffer: async () => Uint8Array.from([9, 9]).buffer,
      }) as unknown as Response;
    await expect(materializeImageUrl("https://provider.example/tmp.png", { upload, fetchImpl })).resolves.toBe(
      "https://cdn.example/designs/stored.png",
    );
    expect(isOwnStorageUrl("https://cdn.example/designs/already.png")).toBe(true);
    await expect(materializeImageUrl("https://cdn.example/designs/already.png", { upload })).resolves.toBe(
      "https://cdn.example/designs/already.png",
    );
    expect(uploads).toHaveLength(2);
  });

  it("uses Blob only when S3 is incomplete", () => {
    process.env.BLOB_READ_WRITE_TOKEN = "blob-token";
    process.env.AWS_ACCESS_KEY_ID = "key";
    expect(storageBackend()).toBe("blob");
  });
});

describe("web push", () => {
  it("builds the service-worker payload and skips until VAPID is complete", async () => {
    expect(vapidConfigured()).toBe(false);
    expect(pushPayload({ title: "New order", body: "CHF 8", href: "/orders" })).toEqual({
      title: "New order",
      body: "CHF 8",
      url: "/orders",
    });
    const db = await getDb();
    const skipped = await dispatchEventPush(db, { type: "order.new", title: "Sale" }, async () => {
      throw new Error("should not send");
    });
    expect(skipped.skipped).toBe("unconfigured");
    process.env.VAPID_PUBLIC_KEY = "pub";
    process.env.VAPID_PRIVATE_KEY = "priv";
    process.env.VAPID_SUBJECT = "not-a-url";
    expect(vapidConfigured()).toBe(false);
    process.env.VAPID_SUBJECT = "mailto:kai@example.com";
    expect(vapidConfigured()).toBe(true);

    const endpoint = "https://push.example/subscription-test";
    await deletePushSubscription(db, endpoint);
    await savePushSubscription(db, { endpoint, p256dh: "p256", auth: "auth", userAgent: "vitest" });
    await savePushSubscription(db, { endpoint, p256dh: "p256-new", auth: "auth-new", userAgent: "vitest" });
    const [row] = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
    expect(row.p256dh).toBe("p256-new");

    const sent: string[] = [];
    const sender: PushSender = async (sub, payload) => {
      sent.push(`${sub.endpoint}:${payload}`);
    };
    const quiet = await dispatchEventPush(db, { type: "design.generated", title: "Art" }, sender);
    expect(quiet.skipped).toBe("type");
    expect(sent).toHaveLength(0);

    const result = await dispatchEventPush(db, { type: "approval.pending", title: "Approve", href: "/queue" }, sender);
    expect(result.sent).toBeGreaterThanOrEqual(1);
    expect(sent.some((line) => line.includes('"url":"/queue"'))).toBe(true);

    const gone: PushSender = async () => {
      throw Object.assign(new Error("gone"), { statusCode: 410 });
    };
    const removed = await dispatchEventPush(db, { type: "order.new", title: "Sale" }, gone);
    expect(removed.removed).toBeGreaterThanOrEqual(1);
    const left = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
    expect(left).toHaveLength(0);
  });
});

describe("Printify webhook", () => {
  const secret = "whsec_test";
  const orderPayload = {
    id: "evt-order-1",
    type: "order:shipment:created",
    resource: {
      id: "pfy-order-9",
      type: "order",
      data: {
        status: "shipped",
        external_id: "receipt-55",
        metadata: { shop_order_id: "receipt-55" },
        address_to: { email: "buyer@example.com", first_name: "Ada", address1: "1 Road" },
        line_items: [{ product_id: "pfy-product-3", metadata: { external_id: "etsy-listing-77" } }],
      },
    },
  };

  it("verifies the hmac and rejects a missing production secret", () => {
    const raw = JSON.stringify(orderPayload);
    const signature = printifySignature(secret, raw);
    expect(verifyPrintifySignature(secret, raw, signature)).toBe(true);
    expect(verifyPrintifySignature(secret, raw, "sha256=deadbeef")).toBe(false);
    expect(verifyPrintifySignature(secret, `${raw} `, signature)).toBe(false);
    process.env.PRINTIFY_WEBHOOK_SECRET = secret;
    expect(authorizePrintifyWebhook(raw, signature)).toBe("verified");
    expect(authorizePrintifyWebhook(raw, "sha256=nope")).toBe("bad-signature");
    delete process.env.PRINTIFY_WEBHOOK_SECRET;
    expect(authorizePrintifyWebhook(raw, null, "production")).toBe("missing-secret");
    expect(authorizePrintifyWebhook(raw, null, "test")).toBe("unsigned-dev");
  });

  it("extracts product, order, and Etsy ids and strips contact fields", () => {
    const mapping = extractPrintifyMapping(orderPayload, JSON.stringify(orderPayload));
    expect(mapping).toMatchObject({
      eventId: "evt-order-1",
      topic: "order:shipment:created",
      printifyProductId: "pfy-product-3",
      printifyOrderId: "pfy-order-9",
      etsyListingId: "etsy-listing-77",
      etsyOrderId: "receipt-55",
      fulfillment: "shipped",
    });
    const redacted = redactWebhookPayload(orderPayload) as { resource: { data: Record<string, unknown> } };
    expect(redacted.resource.data.address_to).toBeUndefined();
    expect(JSON.stringify(redacted)).not.toContain("buyer@example.com");

    const product = extractPrintifyMapping(
      {
        id: "evt-product-1",
        type: "product:publish:started",
        resource: { id: "pfy-product-3", type: "product", data: { action: "create", external: { id: "etsy-listing-77" } } },
      },
      "{}",
    );
    expect(product.printifyProductId).toBe("pfy-product-3");
    expect(product.etsyListingId).toBe("etsy-listing-77");
    expect(product.printifyOrderId).toBeUndefined();
  });

  it("stores a delivery once and links local listing and order rows", async () => {
    const db = await getDb();
    const raw = JSON.stringify(orderPayload);
    await db.delete(printifyEvents).where(eq(printifyEvents.eventId, "evt-order-1"));

    const [listing] = await db
      .insert(listings)
      .values({
        niche: "alpine",
        productType: "pod",
        title: "Webhook poster",
        tags: ["a"],
        description: "d",
        imageUrl: "/api/placeholder/1",
        priceChf: 29,
        netChf: 10,
        marginPct: 30,
        printifyProductId: "pfy-product-3",
        etsyListingId: "dry-etsy-old",
        status: "published",
      })
      .returning();
    const [order] = await db
      .insert(orders)
      .values({
        etsyReceiptId: "receipt-55",
        listingId: listing.id,
        buyerCountry: "CH",
        totalChf: 29,
        feesChf: 4,
        profitChf: 10,
        fulfillmentStatus: "pending",
      })
      .returning();

    process.env.PRINTIFY_WEBHOOK_SECRET = secret;
    const res = await printifyWebhook(new Request("http://localhost/api/webhooks/printify", { method: "POST", body: raw, headers: { "x-pfy-signature": printifySignature(secret, raw) } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, duplicate: false, verified: true, listingUpdated: true, orderUpdated: true, topic: "order:shipment:created" });

    const again = await ingestPrintifyWebhook(db, { rawBody: raw, payload: orderPayload, verified: true });
    expect(again.duplicate).toBe(true);
    const stored = await db.select().from(printifyEvents).where(eq(printifyEvents.eventId, "evt-order-1"));
    expect(stored).toHaveLength(1);
    expect(stored[0]?.listingId).toBe(listing.id);
    expect(stored[0]?.orderId).toBe(order.id);
    expect(JSON.stringify(stored[0]?.payload)).not.toContain("buyer@example.com");

    const [linkedListing] = await db.select().from(listings).where(eq(listings.id, listing.id));
    const [linkedOrder] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(linkedListing.etsyListingId).toBe("etsy-listing-77");
    expect(linkedOrder.fulfillmentStatus).toBe("shipped");
    expect(linkedOrder.podOrderId).toBe("pfy-order-9");
    expect(config.publishMode).toBe("dry-run");

    const bad = await printifyWebhook(
      new Request("http://localhost/api/webhooks/printify", {
        method: "POST",
        body: raw,
        headers: { "x-pfy-signature": "sha256=nope" },
      }),
    );
    expect(bad.status).toBe(401);
  });
});
