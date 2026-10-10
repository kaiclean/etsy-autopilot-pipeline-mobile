import { and, eq } from "drizzle-orm";
import { getEtsyAdapter } from "@/adapters/etsy";
import { getPrintifyAdapter } from "@/adapters/printify";
import type { DB } from "@/db";
import { designs, listings, podSamples } from "@/db/schema";
import { config } from "@/lib/config";
import { buildFileManifest, manifestIsComplete, type ManifestLoadDeps } from "@/lib/file-manifest";
import { resolvePodPublish } from "@/lib/pod-etsy-id";
import { isMockPlaceholder, digitalActivationRefusal, podEtsyPublishRefusal } from "@/lib/publish-gates";
import { absoluteUrl, podPreset } from "./publish";

async function designProvider(db: DB, designId: number | null) {
  if (!designId) return null;
  const [design] = await db.select({ provider: designs.provider }).from(designs).where(eq(designs.id, designId));
  return design?.provider ?? null;
}

/** Stores filename, pixel size, bytes and sha256 from local bytes, S3, or this app's origin. Does not verify or activate. */
export async function recordDeliveryManifest(db: DB, listingId: number, now = new Date(), deps: ManifestLoadDeps = {}) {
  const [l] = await db.select().from(listings).where(eq(listings.id, listingId));
  if (!l || l.productType !== "digital") return { ok: false as const, error: "Not a digital listing" };
  if (!l.deliveryUrl) return { ok: false as const, error: "Delivery file URL is missing." };
  const manifest = await buildFileManifest(l.deliveryUrl, l.imageUrl, deps);
  if (!manifestIsComplete(manifest)) {
    return { ok: false as const, error: "Could not read the delivery PNG (filename, pixel size, bytes, hash)." };
  }
  const [updated] = await db
    .update(listings)
    .set({ fileManifest: manifest, updatedAt: now })
    .where(and(eq(listings.id, listingId), eq(listings.deliveryUrl, l.deliveryUrl), eq(listings.imageUrl, l.imageUrl)))
    .returning({ id: listings.id });
  if (!updated) return { ok: false as const, error: "Listing artwork changed while the delivery file was being read. Please retry." };
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
  const result = await printify.createAndPublish({
    title: l.title,
    description: l.description,
    tags: l.tags,
    priceChf: l.priceChf,
    imageUrl: absoluteUrl(l.imageUrl),
    preset: podPreset(l.podProvider),
    existingProductId: l.printifyProductId ?? undefined,
    publishToEtsy: true,
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
