import { eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb, type DB } from "@/db";
import { events, listings, orders, shops, type Listing } from "@/db/schema";
import { calculateFees } from "@/lib/fees";
import { externalEtsyIdFromProduct, ETSY_ID_WAIT_MS, resolvePodPublish } from "@/lib/pod-etsy-id";
import { DEFAULT_PUSH_PREFS, pushEventEnabled } from "@/lib/push-prefs";
import { ingestPrintifyWebhook } from "@/lib/printify-webhook";
import { activateDigitalListing, publishPodListingToEtsy } from "@/pipeline/human-publish";
import { saveReceipts } from "@/pipeline/orders";
import { backfillEtsyListingIds, reclassifyStuckPodListings, syncAwaitingEtsyIds } from "@/pipeline/etsy-id-sync";
import { runStage } from "@/pipeline/runner";

const HOUR = 60 * 60 * 1000;

async function sampleListing(db: DB) {
  const [src] = await db.select().from(listings).limit(1);
  if (!src) throw new Error("expected seeded listings");
  return src;
}

async function insertListing(db: DB, overrides: Partial<Listing> & Pick<Listing, "status" | "productType">) {
  const src = await sampleListing(db);
  const [row] = await db
    .insert(listings)
    .values({
      niche: src.niche,
      productType: overrides.productType,
      podProvider: overrides.productType === "pod" ? (src.podProvider ?? "printify:posterA3") : null,
      title: overrides.title ?? src.title,
      tags: src.tags,
      description: src.description,
      imageUrl: src.imageUrl,
      priceChf: overrides.priceChf ?? src.priceChf,
      podCostChf: overrides.podCostChf ?? (overrides.productType === "pod" ? 8 : 0),
      netChf: src.netChf,
      marginPct: src.marginPct,
      status: overrides.status,
      ...(overrides.shopId ? { shopId: overrides.shopId } : {}),
      etsyListingId: overrides.etsyListingId ?? null,
      printifyProductId: overrides.printifyProductId ?? null,
      podBlueprintId: overrides.podBlueprintId ?? null,
      podPrintProviderId: overrides.podPrintProviderId ?? null,
      podPublishedAt: overrides.podPublishedAt ?? null,
      publishedAt: overrides.publishedAt ?? null,
      isDemo: false,
    })
    .returning();
  return row;
}

describe("POD Etsy id resolution", () => {
  it("reads the numeric Etsy id from a Printify product payload", () => {
    expect(externalEtsyIdFromProduct({ external: { id: "1234567890", handle: "https://www.etsy.com/listing/1234567890/art" } })).toBe("1234567890");
    expect(externalEtsyIdFromProduct({ external: { id: 1234567890 } })).toBe("1234567890");
    expect(externalEtsyIdFromProduct({ external: { handle: "https://www.etsy.com/listing/2223334445/name" } })).toBe("2223334445");
    expect(externalEtsyIdFromProduct({ external: [{ id: "99887766" }] })).toBe("99887766");
    expect(externalEtsyIdFromProduct({ data: { external: { id: "44556677" } } })).toBe("44556677");
    expect(externalEtsyIdFromProduct({ external: null })).toBeNull();
    expect(externalEtsyIdFromProduct({})).toBeNull();
    expect(externalEtsyIdFromProduct({ external: { id: "not-an-etsy-id" } })).toBeNull();
  });

  it("never marks a live POD listing published without an Etsy id", () => {
    const cases = [
      resolvePodPublish({ mode: "live", productId: "pfy-1", externalEtsyId: null, previousEtsyListingId: null }),
      resolvePodPublish({ mode: "live", productId: "pfy-1", previousEtsyListingId: "dry-etsy-old" }),
      resolvePodPublish({ mode: "live", productId: "pfy-1", externalEtsyId: "1234567890" }),
      resolvePodPublish({ mode: "live", productId: "pfy-1", previousEtsyListingId: "555666777" }),
      resolvePodPublish({ mode: "dry-run", productId: "dry-pfy-9" }),
    ];
    expect(cases[0]).toEqual({ status: "publishing", etsyListingId: null });
    expect(cases[1]).toEqual({ status: "publishing", etsyListingId: null });
    expect(cases[2]).toEqual({ status: "published", etsyListingId: "1234567890" });
    expect(cases[3]).toEqual({ status: "published", etsyListingId: "555666777" });
    expect(cases[4]).toEqual({ status: "published", etsyListingId: "dry-etsy-dry-pfy-9" });
    for (const result of cases) {
      if (result.status === "published") expect(result.etsyListingId).toBeTruthy();
    }
  });

  it("sends the 24h Etsy-id alert through the failed-job push switch", () => {
    expect(pushEventEnabled(DEFAULT_PUSH_PREFS, "listing.awaiting_etsy_id")).toBe(true);
    expect(pushEventEnabled({ ...DEFAULT_PUSH_PREFS, "job.failed": false }, "listing.awaiting_etsy_id")).toBe(false);
  });
});

describe("POD Etsy id sync and unmatched receipts", () => {
  it("reclassifies published POD rows with a null Etsy id and leaves everything else", async () => {
    const db = await getDb();
    const now = new Date();
    const stuck = await insertListing(db, { status: "published", productType: "pod", printifyProductId: "pfy-stuck-reclass", publishedAt: now });
    const digital = await insertListing(db, { status: "published", productType: "digital", etsyListingId: null, publishedAt: now });
    const live = await insertListing(db, { status: "published", productType: "pod", etsyListingId: "888999000", printifyProductId: "pfy-live-ok", publishedAt: now });

    expect(await reclassifyStuckPodListings(db, now)).toBeGreaterThanOrEqual(1);

    const [stuckAfter] = await db.select().from(listings).where(eq(listings.id, stuck.id));
    const [digitalAfter] = await db.select().from(listings).where(eq(listings.id, digital.id));
    const [liveAfter] = await db.select().from(listings).where(eq(listings.id, live.id));
    expect(stuckAfter.status).toBe("publishing");
    expect(stuckAfter.etsyListingId).toBeNull();
    expect(digitalAfter.status).toBe("published");
    expect(liveAfter.status).toBe("published");
    expect(liveAfter.etsyListingId).toBe("888999000");
  });

  it("reclassifies a sent pod_created row and leaves an unsent Printify product alone", async () => {
    const db = await getDb();
    const now = new Date();
    const sent = await insertListing(db, {
      status: "pod_created",
      productType: "pod",
      printifyProductId: "pfy-sent-reclass",
      podPublishedAt: now,
      etsyListingId: null,
    });
    const unsent = await insertListing(db, {
      status: "pod_created",
      productType: "pod",
      printifyProductId: "pfy-unsent-reclass",
      etsyListingId: null,
    });

    await reclassifyStuckPodListings(db, now);

    const [sentAfter] = await db.select().from(listings).where(eq(listings.id, sent.id));
    const [unsentAfter] = await db.select().from(listings).where(eq(listings.id, unsent.id));
    expect(sentAfter.status).toBe("publishing");
    expect(sentAfter.etsyListingId).toBeNull();
    expect(unsentAfter.status).toBe("pod_created");
    expect(unsentAfter.podPublishedAt).toBeNull();
  });

  it("does not poll or alert a pod_created row, and does alert one that was sent and waited 24h", async () => {
    const db = await getDb();
    const now = new Date();
    const old = new Date(now.getTime() - ETSY_ID_WAIT_MS - HOUR);
    const sent = await insertListing(db, {
      status: "pod_created",
      productType: "pod",
      printifyProductId: "pfy-sent-old",
      podPublishedAt: old,
      publishedAt: old,
    });
    const unsent = await insertListing(db, {
      status: "pod_created",
      productType: "pod",
      printifyProductId: "pfy-unsent-old",
      publishedAt: old,
    });
    const seen: string[] = [];
    await syncAwaitingEtsyIds(db, {
      now,
      lookup: async (ids) => {
        seen.push(...ids);
        return Object.fromEntries(ids.map((id) => [id, null]));
      },
    });

    expect(seen).toContain("pfy-sent-old");
    expect(seen).not.toContain("pfy-unsent-old");
    const [sentAfter] = await db.select().from(listings).where(eq(listings.id, sent.id));
    const [unsentAfter] = await db.select().from(listings).where(eq(listings.id, unsent.id));
    expect(sentAfter.status).toBe("publishing");
    expect(sentAfter.etsyIdWaitAlertedAt).toEqual(now);
    expect(unsentAfter.status).toBe("pod_created");
    expect(unsentAfter.etsyIdWaitAlertedAt).toBeNull();
    const alerts = (await db.select().from(events).where(eq(events.type, "listing.awaiting_etsy_id"))).filter((event) => event.body?.includes(`#${unsent.id}`));
    expect(alerts).toHaveLength(0);
    const sentAlerts = (await db.select().from(events).where(eq(events.type, "listing.awaiting_etsy_id"))).filter((event) => event.body?.includes(`#${sent.id}`));
    expect(sentAlerts).toHaveLength(1);
  });

  it("keeps receipts for unknown listings and links them when the Etsy id arrives", async () => {
    const db = await getDb();
    const now = new Date();
    const listing = await insertListing(db, {
      status: "publishing",
      productType: "pod",
      printifyProductId: "pfy-link-1",
      publishedAt: now,
      priceChf: 40,
      podCostChf: 8,
      title: "Link me poster",
    });
    const known = await insertListing(db, {
      status: "published",
      productType: "pod",
      etsyListingId: "111222333",
      printifyProductId: "pfy-known",
      publishedAt: now,
      podCostChf: 8,
    });
    const logs: string[] = [];
    const saved = await saveReceipts(
      db,
      [
        { receiptId: "receipt-unknown-1", etsyListingId: "1234567890", buyerCountry: "CH", quantity: 1, totalChf: 40, createdAt: now },
        { receiptId: "receipt-known-1", etsyListingId: "111222333", buyerCountry: "DE", quantity: 1, totalChf: 40, createdAt: now },
      ],
      new Map([[known.etsyListingId!, known]]),
      { offsite: () => false, log: (msg) => logs.push(msg), shopId: known.shopId },
    );
    expect(saved).toEqual({ inserted: 2, unmatched: 1 });
    expect(logs.join("\n")).toMatch(/saved as unmatched/);
    expect(logs.join("\n")).not.toMatch(/skipped/);

    const again = await saveReceipts(
      db,
      [{ receiptId: "receipt-unknown-1", etsyListingId: "1234567890", buyerCountry: "CH", quantity: 1, totalChf: 40, createdAt: now }],
      new Map(),
      { offsite: () => false },
    );
    expect(again).toEqual({ inserted: 0, unmatched: 0 });

    const [pending] = await db.select().from(orders).where(eq(orders.etsyReceiptId, "receipt-unknown-1"));
    expect(pending.listingId).toBeNull();
    expect(pending.shopId).toBe(known.shopId);
    expect(pending.matchStatus).toBe("unmatched");
    expect(pending.unmatchedEtsyListingId).toBe("1234567890");
    expect(pending.profitChf).toBe(0);
    expect(pending.totalChf).toBe(40);

    const result = await syncAwaitingEtsyIds(db, {
      now,
      lookup: async (ids) => Object.fromEntries(ids.map((id) => [id, id === "pfy-link-1" ? "1234567890" : null])),
    });
    expect(result.linked).toBeGreaterThanOrEqual(1);

    const [published] = await db.select().from(listings).where(eq(listings.id, listing.id));
    expect(published.status).toBe("published");
    expect(published.etsyListingId).toBe("1234567890");
    const [linked] = await db.select().from(orders).where(eq(orders.etsyReceiptId, "receipt-unknown-1"));
    const expected = calculateFees({ priceChf: 40, quantity: 1, podCostChf: 8, offsiteAds: false });
    expect(linked.listingId).toBe(listing.id);
    expect(linked.matchStatus).toBe("matched");
    expect(linked.totalChf).toBe(40);
    expect(linked.podCostChf).toBe(expected.podCostChf);
    expect(linked.profitChf).toBe(expected.netChf);
  });

  it("alerts once when a listing waits longer than 24 hours", async () => {
    const db = await getDb();
    const now = new Date();
    const old = new Date(now.getTime() - ETSY_ID_WAIT_MS - HOUR);
    const recent = new Date(now.getTime() - HOUR);
    const stalled = await insertListing(db, { status: "publishing", productType: "pod", printifyProductId: "pfy-stalled", publishedAt: old });
    const fresh = await insertListing(db, { status: "publishing", productType: "pod", printifyProductId: "pfy-fresh", publishedAt: recent });
    const lookup = async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, null]));

    await syncAwaitingEtsyIds(db, { now, lookup });
    const alerts = async () =>
      (await db.select().from(events).where(eq(events.type, "listing.awaiting_etsy_id"))).filter((event) => event.body?.includes(`#${stalled.id}`));
    const first = await alerts();
    expect(first).toHaveLength(1);
    expect(first[0]?.severity).toBe("warning");
    expect(first[0]?.body).not.toContain(`#${fresh.id}`);
    const [stalledAfter] = await db.select().from(listings).where(eq(listings.id, stalled.id));
    const [freshAfter] = await db.select().from(listings).where(eq(listings.id, fresh.id));
    expect(stalledAfter.status).toBe("publishing");
    expect(stalledAfter.etsyListingId).toBeNull();
    expect(stalledAfter.etsyIdWaitAlertedAt).toEqual(now);
    expect(freshAfter.etsyIdWaitAlertedAt).toBeNull();

    await syncAwaitingEtsyIds(db, { now, lookup });
    expect(await alerts()).toHaveLength(1);
  });

  it("promotes a publishing listing from the Printify webhook and links the saved receipt", async () => {
    const db = await getDb();
    const now = new Date();
    const listing = await insertListing(db, {
      status: "publishing",
      productType: "pod",
      printifyProductId: "pfy-webhook-etsy",
      publishedAt: now,
      podCostChf: 8,
      priceChf: 40,
    });
    await db.insert(orders).values({
      etsyReceiptId: "receipt-webhook-etsy",
      listingId: null,
      unmatchedEtsyListingId: "3334445555",
      matchStatus: "unmatched",
      buyerCountry: "CH",
      quantity: 1,
      totalChf: 40,
      feesChf: 1,
      profitChf: 0,
      fulfillmentStatus: "pending",
      createdAt: now,
    });
    const payload = {
      id: "evt-etsy-id-webhook",
      type: "product:publish:started",
      resource: { id: "pfy-webhook-etsy", type: "product", data: { external: { id: "3334445555" } } },
    };
    const result = await ingestPrintifyWebhook(db, { rawBody: JSON.stringify(payload), payload, verified: true });
    expect(result.listingUpdated).toBe(true);
    const [after] = await db.select().from(listings).where(eq(listings.id, listing.id));
    const [order] = await db.select().from(orders).where(eq(orders.etsyReceiptId, "receipt-webhook-etsy"));
    expect(after.status).toBe("published");
    expect(after.etsyListingId).toBe("3334445555");
    expect(order.listingId).toBe(listing.id);
    expect(order.matchStatus).toBe("matched");
    expect(order.podCostChf).toBe(8);
  });

  it("orders stage moves a stuck published row to publishing without an Etsy id", async () => {
    const db = await getDb();
    const now = new Date();
    const stuck = await insertListing(db, {
      status: "published",
      productType: "pod",
      printifyProductId: "pfy-orders-stuck",
      etsyListingId: null,
      publishedAt: now,
    });
    const run = await runStage("orders", "cron", { db, random: () => 0, now });
    expect(run.status).toBe("success");
    const [after] = await db.select().from(listings).where(eq(listings.id, stuck.id));
    expect(after.status).toBe("publishing");
    expect(after.etsyListingId).toBeNull();
    expect(after.etsyIdWaitAlertedAt).toBeNull();
  });

  it("backfill reclassifies without fetching, and --fetch uses the lookup", async () => {
    const db = await getDb();
    const now = new Date();
    const stuck = await insertListing(db, { status: "published", productType: "pod", printifyProductId: "pfy-backfill", etsyListingId: null, publishedAt: now });
    const sent = await insertListing(db, { status: "pod_created", productType: "pod", printifyProductId: "pfy-backfill-sent", podPublishedAt: now, etsyListingId: null });
    const unsent = await insertListing(db, { status: "pod_created", productType: "pod", printifyProductId: "pfy-backfill-unsent", etsyListingId: null });
    const quiet = await backfillEtsyListingIds(db, {
      now,
      fetchExternalIds: false,
      lookup: async () => {
        throw new Error("should not fetch");
      },
    });
    expect(quiet.fetched).toBe(false);
    expect(quiet.linked).toBe(0);
    const [waiting] = await db.select().from(listings).where(eq(listings.id, stuck.id));
    const [sentAfter] = await db.select().from(listings).where(eq(listings.id, sent.id));
    const [unsentAfter] = await db.select().from(listings).where(eq(listings.id, unsent.id));
    expect(waiting.status).toBe("publishing");
    expect(sentAfter.status).toBe("publishing");
    expect(unsentAfter.status).toBe("pod_created");

    await expect(backfillEtsyListingIds(db, { fetchExternalIds: true })).rejects.toThrow(/PRINTIFY_API_TOKEN/);

    const fetched = await backfillEtsyListingIds(db, {
      now,
      fetchExternalIds: true,
      lookup: async (ids) => Object.fromEntries(ids.map((id) => [id, id === "pfy-backfill" ? "777666555" : null])),
    });
    expect(fetched.fetched).toBe(true);
    expect(fetched.linked).toBeGreaterThanOrEqual(1);
    const [done] = await db.select().from(listings).where(eq(listings.id, stuck.id));
    expect(done.status).toBe("published");
    expect(done.etsyListingId).toBe("777666555");
    await db.delete(orders).where(inArray(orders.etsyReceiptId, ["receipt-unknown-1", "receipt-known-1", "receipt-webhook-etsy"]));
  });

  it("keeps Etsy-id sync inside the shop that owns the listing and the receipt", async () => {
    const db = await getDb();
    const now = new Date();
    const [home] = await db.select().from(shops).where(eq(shops.slug, "omnishop-ch"));
    expect(home?.id).toBeTruthy();
    const [other] = await db
      .insert(shops)
      .values({ slug: "other-shop-etsy-sync", displayName: "Other shop" })
      .returning();
    const homeListing = await insertListing(db, {
      shopId: home.id,
      status: "publishing",
      productType: "pod",
      printifyProductId: "pfy-home-shop",
      publishedAt: now,
      podCostChf: 8,
      priceChf: 40,
    });
    const otherListing = await insertListing(db, {
      shopId: other.id,
      status: "published",
      productType: "pod",
      printifyProductId: "pfy-other-shop",
      etsyListingId: null,
      publishedAt: now,
    });
    await db.insert(orders).values([
      {
        shopId: home.id,
        etsyReceiptId: "receipt-home-shop",
        listingId: null,
        unmatchedEtsyListingId: "555000111",
        matchStatus: "unmatched",
        buyerCountry: "CH",
        quantity: 1,
        totalChf: 40,
        feesChf: 1,
        profitChf: 0,
        fulfillmentStatus: "pending",
        createdAt: now,
      },
      {
        shopId: other.id,
        etsyReceiptId: "receipt-other-shop",
        listingId: null,
        unmatchedEtsyListingId: "555000111",
        matchStatus: "unmatched",
        buyerCountry: "DE",
        quantity: 1,
        totalChf: 40,
        feesChf: 1,
        profitChf: 0,
        fulfillmentStatus: "pending",
        createdAt: now,
      },
    ]);

    const seen: string[] = [];
    const result = await syncAwaitingEtsyIds(db, {
      now,
      shopId: home.id,
      lookup: async (ids) => {
        seen.push(...ids);
        return Object.fromEntries(ids.map((id) => [id, id === "pfy-home-shop" ? "555000111" : null]));
      },
    });
    expect(result.linked).toBeGreaterThanOrEqual(1);
    expect(seen).toContain("pfy-home-shop");
    expect(seen).not.toContain("pfy-other-shop");

    const [homeAfter] = await db.select().from(listings).where(eq(listings.id, homeListing.id));
    const [otherAfter] = await db.select().from(listings).where(eq(listings.id, otherListing.id));
    const [homeOrder] = await db.select().from(orders).where(eq(orders.etsyReceiptId, "receipt-home-shop"));
    const [otherOrder] = await db.select().from(orders).where(eq(orders.etsyReceiptId, "receipt-other-shop"));
    expect(homeAfter.status).toBe("published");
    expect(homeAfter.etsyListingId).toBe("555000111");
    expect(homeAfter.shopId).toBe(home.id);
    expect(homeOrder.listingId).toBe(homeListing.id);
    expect(homeOrder.matchStatus).toBe("matched");
    expect(homeOrder.shopId).toBe(home.id);
    expect(otherAfter.status).toBe("published");
    expect(otherAfter.etsyListingId).toBeNull();
    expect(otherAfter.shopId).toBe(other.id);
    expect(otherOrder.matchStatus).toBe("unmatched");
    expect(otherOrder.listingId).toBeNull();
    expect(otherOrder.shopId).toBe(other.id);

    await db.delete(orders).where(inArray(orders.etsyReceiptId, ["receipt-home-shop", "receipt-other-shop"]));
    await db.delete(listings).where(inArray(listings.id, [homeListing.id, otherListing.id]));
    await db.delete(shops).where(eq(shops.id, other.id));
  });

  it("blocks Activate and Publish to Etsy when the price is under the floor", async () => {
    const db = await getDb();
    const digital = await insertListing(db, {
      status: "published",
      productType: "digital",
      priceChf: 0.5,
      podCostChf: 0,
      etsyListingId: "1234500001",
    });
    const pod = await insertListing(db, {
      status: "pod_created",
      productType: "pod",
      priceChf: 10,
      podCostChf: 13,
      printifyProductId: "pfy-floor",
      podBlueprintId: 1,
      podPrintProviderId: 2,
    });
    const activated = await activateDigitalListing(db, digital.id);
    const published = await publishPodListingToEtsy(db, pod.id);
    expect(activated.ok).toBe(false);
    if (!activated.ok) expect(activated.error).toMatch(/cost plus fees/);
    expect(published.ok).toBe(false);
    if (!published.ok) expect(published.error).toMatch(/25%/);
    const [digitalAfter] = await db.select().from(listings).where(eq(listings.id, digital.id));
    const [podAfter] = await db.select().from(listings).where(eq(listings.id, pod.id));
    expect(digitalAfter.activatedAt).toBeNull();
    expect(podAfter.podPublishedAt).toBeNull();
    expect(podAfter.status).toBe("pod_created");
  });
});
