import { and, eq, sql } from "drizzle-orm";
import { getEtsyAdapter } from "@/adapters/etsy";
import { getPrintifyAdapter } from "@/adapters/printify";
import type { DB } from "@/db";
import { designs, listings, podSamples } from "@/db/schema";
import { config } from "@/lib/config";
import { buildFileManifest, manifestIsComplete, type ArtworkManifest, type ManifestLoadDeps } from "@/lib/file-manifest";
import { verifyListingDeliveryPack, withArtworkPackContents } from "@/lib/artwork-pack";
import { loadArtworkBytes } from "@/lib/artwork-source";
import { etsyDeliveryFingerprint } from "@/lib/etsy-delivery";
import { resolvePodPublish } from "@/lib/pod-etsy-id";
import { isMockPlaceholder, digitalActivationRefusal, podEtsyPublishRefusal } from "@/lib/publish-gates";
import { absoluteUrl, podPreset } from "./publish";

async function designProvider(db: DB, designId: number | null) {
  if (!designId) return null;
  const [design] = await db.select({ provider: designs.provider }).from(designs).where(eq(designs.id, designId));
  return design?.provider ?? null;
}

/** Stores filename, pixel size, bytes and sha256 from local bytes, S3, or this app's origin. Does not verify or activate. */
export async function recordDeliveryManifest(db: DB, listingId: number, now = new Date(), deps: ManifestLoadDeps = {}, read = loadArtworkBytes) {
  const [l] = await db.select().from(listings).where(eq(listings.id, listingId));
  if (!l || l.productType !== "digital") return { ok: false as const, error: "Not a digital listing" };
  if (!l.deliveryUrl) return { ok: false as const, error: "Delivery file URL is missing." };
  const manifest = await buildFileManifest(l.deliveryUrl, l.imageUrl, deps);
  if (!manifestIsComplete(manifest)) {
    return { ok: false as const, error: "Could not read the delivery image (PNG, JPEG or WebP: filename, pixel size, bytes, hash)." };
  }
  if (manifest && manifest.delivery.sha256 === l.fileManifest?.delivery.sha256) {
    manifest.delivery.filename = l.fileManifest.delivery.filename;
    if (!manifest.provenance) {
      const previous = (l.fileManifest as ArtworkManifest | null)?.provenance;
      if (previous) manifest.provenance = previous;
    }
  }
  const deliveryPackVerified = await verifyListingDeliveryPack({ ...l, fileManifest: manifest }, read);
  const [updated] = await db
    .update(listings)
    .set({ fileManifest: manifest, fileVerifiedAt: null, fileVerifiedBy: null, updatedAt: now,
      ...(l.deliveryPack ? { description: withArtworkPackContents(l.description, l.deliveryPack, false) } : {}) })
    .where(and(eq(listings.id, listingId), eq(listings.deliveryUrl, l.deliveryUrl), eq(listings.imageUrl, l.imageUrl),
      eq(listings.description, l.description),
      sql`${listings.deliveryPack} IS NOT DISTINCT FROM ${l.deliveryPack ? JSON.stringify(l.deliveryPack) : null}::jsonb`))
    .returning({ id: listings.id });
  if (!updated) return { ok: false as const, error: "Listing artwork changed while the delivery file was being read. Please retry." };
  if (!deliveryPackVerified) return { ok: false as const, error: "Primary manifest recorded, but attached export files changed or are unreadable. Regenerate exports before verification." };
  return { ok: true as const, manifest };
}

export async function markDeliveryVerified(db: DB, listingId: number, actor: string, now = new Date(), read = loadArtworkBytes) {
  const [l] = await db.select().from(listings).where(eq(listings.id, listingId));
  if (!l || l.productType !== "digital") return { ok: false as const, error: "Not a digital listing" };
  if (!manifestIsComplete(l.fileManifest)) {
    return { ok: false as const, error: "Record the delivery file before marking it verified." };
  }
  const provider = await designProvider(db, l.designId);
  if (isMockPlaceholder(config.imageProvider, provider)) {
    return { ok: false as const, error: "Cannot verify the mock placeholder. Generate a real file first." };
  }
  if (!await verifyListingDeliveryPack(l, read)) {
    await db.update(listings).set({ fileVerifiedAt: null, fileVerifiedBy: null, updatedAt: now,
      ...(l.deliveryPack ? { description: withArtworkPackContents(l.description, l.deliveryPack, false) } : {}) }).where(and(eq(listings.id, listingId),
        eq(listings.description, l.description),
        sql`${listings.deliveryPack} IS NOT DISTINCT FROM ${l.deliveryPack ? JSON.stringify(l.deliveryPack) : null}::jsonb`));
    return { ok: false as const, error: "Attached delivery files changed or are unreadable. Regenerate exports and review every file before verification." };
  }
  const [updated] = await db
    .update(listings)
    .set({ fileVerifiedAt: now, fileVerifiedBy: actor, updatedAt: now,
      ...(l.deliveryPack ? { description: withArtworkPackContents(l.description, l.deliveryPack, true) } : {}) })
    .where(and(eq(listings.id, listingId), sql`${listings.deliveryPack} IS NOT DISTINCT FROM ${l.deliveryPack ? JSON.stringify(l.deliveryPack) : null}::jsonb`,
      eq(listings.description, l.description),
      sql`${listings.fileManifest} IS NOT DISTINCT FROM ${JSON.stringify(l.fileManifest)}::jsonb`,
      sql`${listings.deliveryUrl} IS NOT DISTINCT FROM ${l.deliveryUrl}`))
    .returning({ id: listings.id });
  if (!updated) return { ok: false as const, error: "Delivery files changed during verification. Review and retry." };
  return { ok: true as const };
}

/** Human activation. The publish cron never calls this. */
export async function activateDigitalListing(db: DB, listingId: number, now = new Date(), read = loadArtworkBytes) {
  const [l] = await db.select().from(listings).where(eq(listings.id, listingId));
  if (!l || l.productType !== "digital") return { ok: false as const, error: "Not a digital listing" };
  const provider = await designProvider(db, l.designId);
  const deliveryPackVerified = await verifyListingDeliveryPack(l, read);
  if (!deliveryPackVerified && l.deliveryPack) {
    await db.update(listings).set({ fileVerifiedAt: null, fileVerifiedBy: null, updatedAt: now,
      description: withArtworkPackContents(l.description, l.deliveryPack, false) }).where(and(eq(listings.id, listingId),
        eq(listings.description, l.description),
        sql`${listings.deliveryPack} IS NOT DISTINCT FROM ${JSON.stringify(l.deliveryPack)}::jsonb`));
  }
  const refusal = digitalActivationRefusal({
    imageProvider: config.imageProvider,
    designProvider: provider,
    manifest: l.fileManifest,
    fileVerifiedAt: l.fileVerifiedAt,
    etsyListingId: l.etsyListingId,
    imageUrl: l.imageUrl,
    deliveryUrl: l.deliveryUrl,
    deliveryPack: l.deliveryPack,
    deliveryPackVerified,
  });
  if (refusal) return { ok: false as const, error: refusal };
  if (l.status !== "published" || l.publishMode !== "live" || !l.publishedAt || l.publishError !== null) {
    return { ok: false as const, error: "Cannot activate: the current live Etsy draft publish must complete successfully, including every image and delivery-file upload." };
  }
  if (l.deliveryPack && (!l.etsyDeliveryFingerprint || l.etsyDeliveryFingerprint !== etsyDeliveryFingerprint(l))) {
    return { ok: false as const, error: "Cannot activate: Etsy delivery attachments are not confirmed for the current file revision. Complete a live publish of every current delivery file first." };
  }
  const etsy = await getEtsyAdapter(db, undefined, "write", l.shopId);
  if (etsy.mode !== "live" && !l.etsyListingId!.startsWith("dry-")) {
    return { ok: false as const, error: "Cannot activate a real Etsy draft while live writes are disabled or the shop connection is unavailable." };
  }
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
