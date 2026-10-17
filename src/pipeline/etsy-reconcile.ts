import { randomUUID } from "node:crypto";
import { and, eq, isNull, lte, or } from "drizzle-orm";
import { getEtsyAdapter } from "@/adapters/etsy";
import type { DB } from "@/db";
import { etsyListingObservations, type EtsyInboxEvent } from "@/db/etsy-events";
import { listings, shops } from "@/db/schema";
import { saveReceipts } from "@/pipeline/orders";

/** Notifications are invalidations, never authoritative state changes or supplier commands. */
export async function reconcileEtsyEvent(db: DB, event: EtsyInboxEvent) {
  const [shop] = await db.select().from(shops).where(eq(shops.id, event.shopId));
  if (!shop || shop.etsyShopId !== event.etsyShopId) throw new Error("Etsy event shop ownership changed");
  if (!/^[1-9]\d{0,18}$/.test(event.resourceId)) throw new Error("Invalid Etsy resource identifier");
  const etsy = await getEtsyAdapter(db, undefined, "read", shop.id);
  if (etsy.mode !== "live") throw new Error("Live Etsy reads unavailable; retain event for recovery");
  if (event.resourceType === "receipt") {
    if (!etsy.getReceipt) throw new Error("Etsy receipt lookup unavailable");
    const receipts = await etsy.getReceipt(event.resourceId);
    const local = await db.select().from(listings).where(eq(listings.shopId, shop.id));
    // Shared receipt persistence deduplicates transaction ids. No Printify/Gelato fulfillment is invoked here.
    await saveReceipts(db, receipts, new Map(local.filter((l) => l.etsyListingId).map((l) => [l.etsyListingId!, l])), {
      shopId: shop.id, isDemo: false, offsite: () => false,
    });
    return;
  }
  const [local] = await db.select({ id: listings.id }).from(listings)
    .where(and(eq(listings.shopId, shop.id), eq(listings.etsyListingId, event.resourceId)));
  if (!local) throw new Error("Etsy listing does not belong to the event shop");
  if (!etsy.getListing) throw new Error("Etsy listing lookup unavailable");
  const fetchToken = randomUUID();
  // Fence concurrent reads across processes: an older, slower response cannot replace a newer fetch.
  await db.insert(etsyListingObservations).values({
    shopId: shop.id, etsyListingId: event.resourceId, fetchToken,
  }).onConflictDoUpdate({
    target: [etsyListingObservations.shopId, etsyListingObservations.etsyListingId],
    set: { fetchToken },
  });
  const observedAt = new Date();
  const remote = await etsy.getListing(event.resourceId);
  if (remote.listingId !== event.resourceId || remote.shopId !== event.etsyShopId) throw new Error("Etsy listing ownership mismatch");
  if (typeof remote.state !== "string" || !/^[a-z_]{1,32}$/.test(remote.state)) throw new Error("Invalid Etsy listing state");
  const quantity = remote.quantity;
  if (quantity != null && (!Number.isSafeInteger(quantity) || quantity < 0)) throw new Error("Invalid Etsy listing quantity");
  if (remote.updatedAt && !Number.isFinite(remote.updatedAt.getTime())) throw new Error("Invalid Etsy listing timestamp");
  await db.update(etsyListingObservations).set({
    state: remote.state, quantity: quantity ?? null, observedAt, fetchToken: null,
    ...(remote.updatedAt ? { remoteUpdatedAt: remote.updatedAt } : {}),
  }).where(and(
    eq(etsyListingObservations.shopId, shop.id), eq(etsyListingObservations.etsyListingId, event.resourceId),
    eq(etsyListingObservations.fetchToken, fetchToken),
    remote.updatedAt ? or(isNull(etsyListingObservations.remoteUpdatedAt), lte(etsyListingObservations.remoteUpdatedAt, remote.updatedAt)) : undefined,
  ));
}
