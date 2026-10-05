import { and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import type { DB } from "@/db";
import { listings, orders, type Listing } from "@/db/schema";
import { emit } from "@/lib/events";
import { calculateFees } from "@/lib/fees";
import { ETSY_ID_WAIT_MS } from "@/lib/pod-etsy-id";

export type ExternalEtsyIdLookup = (productIds: string[]) => Promise<Record<string, string | null>>;

export type EtsyIdSyncResult = {
  reclassified: number;
  linked: number;
  waiting: number;
  alerted: number;
};

type LogFn = (msg: string, level?: "info" | "warn" | "error") => void;

function waitingSince(row: Pick<Listing, "podPublishedAt" | "publishedAt" | "updatedAt" | "createdAt">) {
  return row.podPublishedAt ?? row.publishedAt ?? row.updatedAt ?? row.createdAt;
}

/**
 * POD rows that were sent to Etsy without an id are not fully published.
 * `pod_created` with no `podPublishedAt` is only a Printify product: leave it alone.
 */
export async function reclassifyStuckPodListings(db: DB, now = new Date()) {
  const stuck = await db
    .select()
    .from(listings)
    .where(
      and(
        eq(listings.productType, "pod"),
        isNull(listings.etsyListingId),
        or(
          eq(listings.status, "published"),
          and(eq(listings.status, "pod_created"), isNotNull(listings.podPublishedAt)),
        ),
      ),
    );
  for (const row of stuck) {
    await db
      .update(listings)
      .set({
        status: "publishing",
        publishedAt: row.podPublishedAt ?? row.publishedAt ?? row.updatedAt ?? row.createdAt,
        updatedAt: now,
      })
      .where(eq(listings.id, row.id));
  }
  return stuck.length;
}

/** Attach saved receipts that were waiting on this Etsy listing id. Profit is filled in here. */
export async function linkUnmatchedOrders(
  db: DB,
  listing: Pick<Listing, "id" | "title" | "productType" | "podCostChf">,
  etsyListingId: string,
  now: Date,
) {
  const pending = await db
    .select()
    .from(orders)
    .where(and(eq(orders.unmatchedEtsyListingId, etsyListingId), eq(orders.matchStatus, "unmatched")));
  for (const order of pending) {
    const unit = order.quantity > 0 ? order.totalChf / order.quantity : order.totalChf;
    const fees = calculateFees({
      priceChf: unit,
      quantity: order.quantity,
      podCostChf: listing.podCostChf,
      offsiteAds: order.offsiteAdsChf > 0,
    });
    await db
      .update(orders)
      .set({
        listingId: listing.id,
        matchStatus: "matched",
        feesChf: fees.totalEtsyFeesChf,
        podCostChf: fees.podCostChf,
        offsiteAdsChf: fees.offsiteAdsFeeChf,
        profitChf: fees.netChf,
        fulfillmentStatus:
          listing.productType === "digital" && order.fulfillmentStatus === "pending" ? "delivered_digital" : order.fulfillmentStatus,
        updatedAt: now,
      })
      .where(eq(orders.id, order.id));
  }
  if (pending.length) {
    await emit(db, {
      type: "order.matched",
      title: pending.length === 1 ? "Order linked to listing" : `${pending.length} orders linked to a listing`,
      body: `${listing.title.slice(0, 70)} · Etsy ${etsyListingId}`,
      severity: "success",
      href: "/orders",
    });
  }
  return pending.length;
}

/**
 * Read Printify product `external.id` for rows still waiting, promote them to published,
 * and raise one alert for anything still waiting after 24h.
 */
export async function syncAwaitingEtsyIds(
  db: DB,
  opts: { now: Date; lookup: ExternalEtsyIdLookup; log?: LogFn },
): Promise<EtsyIdSyncResult> {
  const log = opts.log ?? (() => {});
  const reclassified = await reclassifyStuckPodListings(db, opts.now);
  const awaiting = await db.select().from(listings).where(eq(listings.status, "publishing"));
  const withProduct = awaiting.filter((row) => row.printifyProductId);
  let reads: Record<string, string | null> = {};
  if (withProduct.length) {
    try {
      reads = await opts.lookup(withProduct.map((row) => row.printifyProductId!));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Printify Etsy-id lookup failed: ${message}`, "warn");
    }
  }

  let linked = 0;
  const stillWaiting: Listing[] = [];
  for (const row of awaiting) {
    const productId = row.printifyProductId;
    const raw = productId ? reads[productId] : undefined;
    const etsyListingId = raw && /^\d{5,}$/.test(raw.trim()) ? raw.trim() : null;
    if (etsyListingId) {
      await db
        .update(listings)
        .set({
          status: "published",
          etsyListingId,
          publishError: null,
          updatedAt: opts.now,
          publishedAt: row.publishedAt ?? opts.now,
        })
        .where(eq(listings.id, row.id));
      const matched = await linkUnmatchedOrders(db, row, etsyListingId, opts.now);
      linked++;
      log(`#${row.id} Etsy listing ${etsyListingId} arrived from Printify product ${productId} (${matched} order(s) linked)`);
      continue;
    }
    if (productId && !(productId in reads)) log(`#${row.id} Printify product ${productId} could not be read; still awaiting an Etsy id`, "warn");
    else if (!productId) log(`#${row.id} is awaiting an Etsy id but has no Printify product id`, "warn");
    stillWaiting.push(row);
  }

  const overdue = stillWaiting.filter(
    (row) => !row.etsyIdWaitAlertedAt && opts.now.getTime() - waitingSince(row).getTime() >= ETSY_ID_WAIT_MS,
  );
  let alerted = 0;
  if (overdue.length) {
    const labels = overdue.map((row) => `#${row.id}`).join(", ");
    await emit(db, {
      type: "listing.awaiting_etsy_id",
      title: overdue.length === 1 ? "Listing still waiting for an Etsy id" : `${overdue.length} listings still waiting for an Etsy id`,
      body: `${labels} ${overdue.length === 1 ? "has" : "have"} been waiting more than 24 hours after Printify publish. Orders for ${overdue.length === 1 ? "it are" : "them are"} kept until the id arrives.`,
      severity: "warning",
      href: "/products",
    });
    await db.update(listings).set({ etsyIdWaitAlertedAt: opts.now, updatedAt: opts.now }).where(inArray(listings.id, overdue.map((row) => row.id)));
    alerted = overdue.length;
    log(`Alerted on ${labels} waiting more than 24h for an Etsy id`, "warn");
  }

  if (reclassified || linked || stillWaiting.length) {
    log(`Etsy ids: reclassified ${reclassified}, linked ${linked}, still waiting ${stillWaiting.length}`);
  }
  return { reclassified, linked, waiting: stillWaiting.length, alerted };
}

/** Status-only pass, or the same poll the orders stage runs. `--fetch` is a Printify GET, not a write. */
export async function backfillEtsyListingIds(
  db: DB,
  opts: { now?: Date; fetchExternalIds?: boolean; lookup?: ExternalEtsyIdLookup; log?: LogFn } = {},
): Promise<EtsyIdSyncResult & { fetched: boolean }> {
  const now = opts.now ?? new Date();
  if (!opts.fetchExternalIds) {
    const reclassified = await reclassifyStuckPodListings(db, now);
    return { reclassified, linked: 0, waiting: 0, alerted: 0, fetched: false };
  }
  if (!opts.lookup) throw new Error("PRINTIFY_API_TOKEN and PRINTIFY_SHOP_ID are required to fetch Etsy ids. The fetch is a GET of the Printify product and does not publish.");
  const result = await syncAwaitingEtsyIds(db, { now, lookup: opts.lookup, log: opts.log });
  return { ...result, fetched: true };
}
