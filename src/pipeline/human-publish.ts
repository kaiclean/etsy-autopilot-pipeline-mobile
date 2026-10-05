import { and, eq } from "drizzle-orm";
import { getEtsyAdapter } from "@/adapters/etsy";
import { getPrintifyAdapter } from "@/adapters/printify";
import type { DB } from "@/db";
import { designs, listings, podSamples, type Listing } from "@/db/schema";
import { config } from "@/lib/config";
import { resolveUsdToChf } from "@/lib/fee-schedule";
import { priceFloorIssue } from "@/lib/fees";
import { manifestIsComplete, tryBuildFileManifest } from "@/lib/file-manifest";
import { resolvePodPublish } from "@/lib/pod-etsy-id";
import { isMockPlaceholder, digitalActivationRefusal, podEtsyPublishRefusal } from "@/lib/publish-gates";
import { getSetting } from "@/lib/settings";
import { absoluteUrl, podPreset } from "./publish";

async function priceFloor(db: DB, listing: Pick<Listing, "priceChf" | "productType" | "podCostChf">) {
  const [automation, feeFx] = await Promise.all([getSetting(db, "automation"), getSetting(db, "feeFx")]);
  const fx = resolveUsdToChf({ stored: feeFx?.usdToChf, storedAsOf: feeFx?.asOf });
  return priceFloorIssue({
    priceChf: listing.priceChf,
    productType: listing.productType,
    podCostChf: listing.podCostChf,
    offsiteAds: automation.assumeOffsiteAds,
    usdToChf: fx.rate,
  });
}

async function designProvider(db: DB, designId: number | null) {
  if (!designId) return null;
  const [design] = await db.select({ provider: designs.provider }).from(designs).where(eq(designs.id, designId));
  return design?.provider ?? null;
}

/** Stores filename, pixel size, bytes and sha256 when the file is readable locally. Does not verify or activate. */
export async function recordDeliveryManifest(db: DB, listingId: number, now = new Date()) {
  const [l] = await db.select().from(listings).where(eq(listings.id, listingId));
  if (!l || l.productType !== "digital") return { ok: false as const, error: "Not a digital listing" };
  if (!l.deliveryUrl) return { ok: false as const, error: "Delivery file URL is missing." };
  const manifest = tryBuildFileManifest(l.deliveryUrl, l.imageUrl);
  if (!manifestIsComplete(manifest)) {
    return { ok: false as const, error: "Could not read the delivery PNG (filename, pixel size, bytes, hash)." };
  }
  await db.update(listings).set({ fileManifest: manifest, updatedAt: now }).where(eq(listings.id, listingId));
  return { ok: true as const, manifest };
}

export async function markDeliveryVerified(db: DB, listingId: number, actor: string, now = new Date()) {
  const [l] = await db.select().from(listings).where(eq(listings.id, listingId));
  if (!l || l.productType !== "digital") return { ok: false as const, error: "Not a digital listing" };
  if (!manifestIsComplete(l.fileManifest)) {
    return { ok: false as const, error: "Record the delivery file before marking it verified." };
  }
  const provider = await designProvider(db, l.designId);
  if (isMockPlaceholder(config.imageProvider, provider)) {
    return { ok: false as const, error: "Cannot verify the mock placeholder. Generate a real file first." };
  }
  await db
    .update(listings)
    .set({ fileVerifiedAt: now, fileVerifiedBy: actor, updatedAt: now })
    .where(eq(listings.id, listingId));
  return { ok: true as const };
}

/** Human activation. The publish cron never calls this. */
export async function activateDigitalListing(db: DB, listingId: number, now = new Date()) {
  const [l] = await db.select().from(listings).where(eq(listings.id, listingId));
  if (!l || l.productType !== "digital") return { ok: false as const, error: "Not a digital listing" };
  const floor = await priceFloor(db, l);
  if (floor) return { ok: false as const, error: floor.message };
  const provider = await designProvider(db, l.designId);
  const refusal = digitalActivationRefusal({
    imageProvider: config.imageProvider,
    designProvider: provider,
    manifest: l.fileManifest,
    fileVerifiedAt: l.fileVerifiedAt,
    etsyListingId: l.etsyListingId,
    imageUrl: l.imageUrl,
    deliveryUrl: l.deliveryUrl,
  });
  if (refusal) return { ok: false as const, error: refusal };
  const etsy = await getEtsyAdapter(db);
  await etsy.activateListing(l.etsyListingId!);
  await db.update(listings).set({ activatedAt: now, updatedAt: now }).where(eq(listings.id, listingId));
  return { ok: true as const };
}

export async function recordPodSample(
  db: DB,
  input: { blueprintId: number; providerId: number; note?: string; actor: string },
  now = new Date(),
) {
  if (!Number.isInteger(input.blueprintId) || input.blueprintId <= 0 || !Number.isInteger(input.providerId) || input.providerId <= 0) {
    return { ok: false as const, error: "Blueprint id and provider id must be positive integers." };
  }
  await db
    .insert(podSamples)
    .values({
      blueprintId: input.blueprintId,
      providerId: input.providerId,
      note: input.note?.slice(0, 500) ?? null,
      approvedAt: now,
      approvedBy: input.actor,
    })
    .onConflictDoUpdate({
      target: [podSamples.blueprintId, podSamples.providerId],
      set: { note: input.note?.slice(0, 500) ?? null, approvedAt: now, approvedBy: input.actor },
    });
  return { ok: true as const };
}

/** Human step: publish one Printify product to Etsy after a sample exists for its blueprint + provider. */
export async function publishPodListingToEtsy(db: DB, listingId: number, now = new Date()) {
  const [l] = await db.select().from(listings).where(eq(listings.id, listingId));
  if (!l || l.productType !== "pod") return { ok: false as const, error: "Not a print-on-demand listing" };
  const floor = await priceFloor(db, l);
  if (floor) return { ok: false as const, error: floor.message };
  const [sample] =
    l.podBlueprintId && l.podPrintProviderId
      ? await db
          .select()
          .from(podSamples)
          .where(and(eq(podSamples.blueprintId, l.podBlueprintId), eq(podSamples.providerId, l.podPrintProviderId)))
      : [];
  const refusal = podEtsyPublishRefusal({
    blueprintId: l.podBlueprintId,
    providerId: l.podPrintProviderId,
    sampleApprovedAt: sample?.approvedAt ?? null,
    printifyProductId: l.printifyProductId,
    alreadyPublished: l.podPublishedAt != null,
  });
  if (refusal) return { ok: false as const, error: refusal };
  const printify = await getPrintifyAdapter({ db });
  const variantPrices = Object.fromEntries((l.podVariantPrices ?? []).map((variant) => [variant.id, variant.priceChf]));
  const result = await printify.createAndPublish({
    title: l.title,
    description: l.description,
    tags: l.tags,
    priceChf: l.priceChf,
    imageUrl: absoluteUrl(l.imageUrl),
    preset: podPreset(l.podProvider),
    existingProductId: l.printifyProductId ?? undefined,
    publishToEtsy: true,
    variantPricesChf: Object.keys(variantPrices).length > 0 ? variantPrices : undefined,
    blueprintId: l.podBlueprintId ?? undefined,
    printProviderId: l.podPrintProviderId ?? undefined,
  });
  const outcome = resolvePodPublish({
    mode: printify.mode,
    productId: result.productId,
    externalEtsyId: result.externalEtsyId,
    previousEtsyListingId: l.etsyListingId,
  });
  await db
    .update(listings)
    .set({
      podPublishedAt: now,
      printifyProductId: result.productId,
      etsyListingId: outcome.etsyListingId,
      // Live Printify returns the Etsy id later. publishing is the wait state; pod_created is not polled.
      status: outcome.status,
      publishMode: printify.mode,
      publishError: null,
      publishedAt: outcome.status === "published" ? (l.publishedAt ?? now) : l.publishedAt,
      updatedAt: now,
    })
    .where(eq(listings.id, listingId));
  return { ok: true as const, etsyListingId: outcome.etsyListingId, status: outcome.status };
}
