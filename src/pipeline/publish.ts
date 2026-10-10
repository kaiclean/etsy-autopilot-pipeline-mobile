import { and, count, eq, isNotNull, isNull, like, lt, notLike, or } from "drizzle-orm";
import { getEtsyAdapter } from "@/adapters/etsy";
import { getPrintifyAdapter } from "@/adapters/printify";
import { PrintifyPublishError } from "@/adapters/printify/client";
import { costs, designs, listings } from "@/db/schema";
import { config, publicAppUrl } from "@/lib/config";
import { emit } from "@/lib/events";
import { FEES, round2, type PodPreset } from "@/lib/fees";
import { validateListing } from "@/lib/listing-validator";
import { buildFileManifest, manifestIsComplete } from "@/lib/file-manifest";
import { digitalDraftRefusal } from "@/lib/publish-gates";
import { fetchPrintifyMockupUrl, printArtworkUrl } from "./mockup";
import { maskSecrets } from "./stage-log";
import { stageResult, type StageFn } from "./types";

export function podPreset(provider: string | null): PodPreset | undefined {
  const name = provider?.startsWith("printify:") ? provider.slice("printify:".length) : undefined;
  if (name === "posterA3" || name === "mug" || name === "tshirt" || name === "sweatshirt") return name;
  return undefined;
}

function reusableId(id: string | null, mode: "dry-run" | "live", prefix: string) {
  if (!id) return undefined;
  if (mode === "live" && id.startsWith(prefix)) return undefined;
  return id;
}

export function absoluteUrl(url: string) {
  if (/^(https?:|data:)/.test(url)) return url;
  return new URL(url, `${publicAppUrl()}/`).toString();
}

/** Same stored error is not sent again until this long after the last attempt. */
export const PUBLISH_RETRY_MS = 24 * 60 * 60 * 1000;
// Both publish routes set maxDuration=300 seconds; keep four times that as recovery grace.
const PUBLISH_ROUTE_MAX_DURATION_MS = 300 * 1000;
export const PUBLISH_STALE_MS = 4 * PUBLISH_ROUTE_MAX_DURATION_MS;
export const AMBIGUOUS_PUBLISH_ERROR_PREFIX = "Publish attempt ended without a recorded provider result.";
export const AMBIGUOUS_PUBLISH_ERROR = `${AMBIGUOUS_PUBLISH_ERROR_PREFIX} Check Etsy or Printify before retrying.`;

export function publishRetryBlocked(
  row: { status: string; publishError: string | null; publishAttemptedAt: Date | null },
  now: Date,
) {
  if (row.status !== "failed" || !row.publishError || !row.publishAttemptedAt) return false;
  if (row.publishError.startsWith(AMBIGUOUS_PUBLISH_ERROR_PREFIX)) return true;
  return now.getTime() - new Date(row.publishAttemptedAt).getTime() < PUBLISH_RETRY_MS;
}

export const runPublish: StageFn = async (ctx) => {
  const { db, log } = ctx;
  const staleAttemptCutoff = new Date(ctx.now.getTime() - PUBLISH_STALE_MS);
  const stale = await db
    .update(listings)
    .set({
      status: "failed",
      publishError: AMBIGUOUS_PUBLISH_ERROR,
      updatedAt: ctx.now,
    })
    .where(
      and(
        eq(listings.status, "publishing"),
        eq(listings.shopId, ctx.shopId),
        isNull(listings.podPublishedAt),
        isNotNull(listings.publishAttemptedAt),
        lt(listings.publishAttemptedAt, staleAttemptCutoff),
        eq(listings.isDemo, ctx.demo),
      ),
    )
    .returning({ id: listings.id });
  if (stale.length) log(`Marked ${stale.length} interrupted publish attempt(s) for operator reconciliation`, "warn");
  const [{ held }] = await db
    .select({ held: count() })
    .from(listings)
    .where(and(
      eq(listings.shopId, ctx.shopId),
      eq(listings.status, "failed"),
      like(listings.publishError, `${AMBIGUOUS_PUBLISH_ERROR_PREFIX}%`),
      ctx.demo ? undefined : eq(listings.isDemo, false),
    ));
  if (held) log(`${held} listing(s) held for operator reconciliation`, "warn");
  const approved = await db
    .select()
    .from(listings)
    .where(
      and(
        eq(listings.shopId, ctx.shopId),
        or(
          eq(listings.status, "approved"),
          and(
            eq(listings.status, "failed"),
            or(isNull(listings.publishError), notLike(listings.publishError, `${AMBIGUOUS_PUBLISH_ERROR_PREFIX}%`)),
          ),
        ),
        // Seeded demo rows never reach a live Etsy or Printify shop.
        ctx.demo ? undefined : eq(listings.isDemo, false),
      ),
    )
    .limit(10);
  if (approved.length === 0) {
    return held ? stageResult(`Nothing approved to publish; held ${held} for operator reconciliation`, "warning") : "Nothing approved to publish.";
  }

  const etsy = await getEtsyAdapter(db, ctx.random);
  const printify = await getPrintifyAdapter({ db, random: ctx.random });
  log(`Etsy adapter: ${etsy.mode} · Printify adapter: ${printify.mode}`);

  let ok = 0;
  let failed = 0;
  let skipped = 0;
  for (const l of approved) {
    if (publishRetryBlocked(l, ctx.now)) {
      skipped++;
      log(`#${l.id} skipped: publish error unchanged for under 24h: ${l.publishError}`, "warn");
      continue;
    }
    const check = validateListing(l);
    if (!check.valid) {
      const [returned] = await db
        .update(listings)
        .set({ status: "pending_approval", validation: check.issues, updatedAt: ctx.now })
        .where(
          and(
            eq(listings.id, l.id),
            eq(listings.status, l.status),
            eq(listings.publishAttemptCount, l.publishAttemptCount),
            eq(listings.updatedAt, l.updatedAt),
            l.publishAttemptedAt ? eq(listings.publishAttemptedAt, l.publishAttemptedAt) : isNull(listings.publishAttemptedAt),
          ),
        )
        .returning({ id: listings.id });
      if (!returned) {
        skipped++;
        log(`#${l.id} skipped: listing changed during validation`, "warn");
        continue;
      }
      log(`#${l.id} failed validation at publish time; returned to queue`, "warn");
      failed++;
      continue;
    }
    const [claimed] = await db
      .update(listings)
      .set({ status: "publishing", publishAttemptedAt: ctx.now, publishAttemptCount: l.publishAttemptCount + 1, publishError: null, updatedAt: ctx.now })
      .where(
        and(
          eq(listings.id, l.id),
          eq(listings.status, l.status),
          eq(listings.publishAttemptCount, l.publishAttemptCount),
          eq(listings.updatedAt, l.updatedAt),
          l.publishAttemptedAt ? eq(listings.publishAttemptedAt, l.publishAttemptedAt) : isNull(listings.publishAttemptedAt),
        ),
      )
      .returning({ id: listings.id, publishAttemptCount: listings.publishAttemptCount });
    if (!claimed) {
      skipped++;
      log(`#${l.id} skipped: another publish run claimed it`, "warn");
      continue;
    }
    const claimWhere = and(
      eq(listings.id, claimed.id),
      eq(listings.status, "publishing"),
      eq(listings.publishAttemptCount, claimed.publishAttemptCount),
      eq(listings.publishAttemptedAt, ctx.now),
    );
    try {
      let etsyListingId: string | null = null;
      let printifyProductId: string | null = null;
      let podBlueprintId: number | null = null;
      let podPrintProviderId: number | null = null;
      let nextStatus: "published" | "pod_created" = "published";
      if (l.productType === "digital") {
        const [design] = l.designId
          ? await db.select({ provider: designs.provider, imageUrl: designs.imageUrl }).from(designs).where(eq(designs.id, l.designId))
          : [];
        let manifest = l.fileManifest;
        if (l.deliveryUrl && !manifestIsComplete(manifest)) {
          const built = await buildFileManifest(l.deliveryUrl, l.imageUrl);
          if (manifestIsComplete(built)) {
            manifest = built;
            await db.update(listings).set({ fileManifest: manifest, updatedAt: ctx.now }).where(eq(listings.id, l.id));
          }
        }
        const refusal = digitalDraftRefusal({
          etsyMode: etsy.mode,
          imageProvider: config.imageProvider,
          designProvider: design?.provider ?? null,
          imageUrl: l.imageUrl,
          deliveryUrl: l.deliveryUrl,
          manifest,
        });
        if (refusal) throw new Error(refusal);
        let listingId = reusableId(l.etsyListingId, etsy.mode, "dry-");
        if (!listingId) {
          const created = await etsy.createDraftListing({
            title: l.title,
            description: l.description,
            priceChf: l.priceChf,
            tags: l.tags,
            type: "download",
          });
          listingId = created.listingId;
          await db.update(listings).set({ etsyListingId: listingId, updatedAt: ctx.now }).where(eq(listings.id, l.id));
        }
        // Gallery is the preview. The buyer file is deliveryUrl. Cron never activates.
        await etsy.uploadListingImage(listingId, absoluteUrl(l.imageUrl));
        await etsy.uploadListingFile(listingId, { name: manifest?.delivery.filename ?? `listing-${l.id}.png`, url: absoluteUrl(l.deliveryUrl!) });
        etsyListingId = listingId;
        log(`#${l.id} → Etsy draft ${listingId} (${etsy.mode}, not activated)`);
      } else {
        let artwork = l.deliveryUrl || l.imageUrl;
        if (l.designId) {
          const [design] = await db.select({ imageUrl: designs.imageUrl }).from(designs).where(eq(designs.id, l.designId));
          artwork = printArtworkUrl(artwork, design?.imageUrl);
        }
        // Create the Printify product only. publish.json is a per-listing human action.
        // etsyListingId stays null. Orders sync does not poll pod_created rows.
        const result = await printify.createAndPublish({
          title: l.title,
          description: l.description,
          tags: l.tags,
          priceChf: l.priceChf,
          imageUrl: absoluteUrl(artwork),
          preset: podPreset(l.podProvider),
          existingProductId: reusableId(l.printifyProductId, printify.mode, "dry-"),
          publishToEtsy: false,
        });
        const mockup = await fetchPrintifyMockupUrl(result.productId);
        if (mockup) {
          await db.update(listings).set({ imageUrl: mockup, updatedAt: ctx.now }).where(eq(listings.id, l.id));
        }
        printifyProductId = result.productId;
        podBlueprintId = result.blueprintId ?? null;
        podPrintProviderId = result.printProviderId ?? null;
        nextStatus = "pod_created";
        log(`#${l.id} → Printify product ${result.productId} created, not published to Etsy (${printify.mode})`);
      }
      const mode = l.productType === "digital" ? etsy.mode : printify.mode;
      const [completed] = await db
        .update(listings)
        .set({
          status: nextStatus,
          ...(l.productType === "digital" ? { etsyListingId } : {}),
          printifyProductId,
          ...(podBlueprintId != null ? { podBlueprintId } : {}),
          ...(podPrintProviderId != null ? { podPrintProviderId } : {}),
          publishMode: mode,
          publishError: null,
          publishAttemptedAt: ctx.now,
          publishedAt: nextStatus === "published" ? ctx.now : null,
          updatedAt: ctx.now,
        })
        .where(claimWhere)
        .returning({ id: listings.id });
      if (!completed) {
        skipped++;
        log(`#${l.id} skipped: publish claim changed before completion`, "warn");
        continue;
      }
      await db.insert(costs).values({
        shopId: ctx.shopId,
        kind: "listing_fee",
        amountChf: round2(FEES.listingFeeUsd * FEES.usdToChf * (1 + FEES.vatOnFeesRate)),
        note: `Listing fee #${l.id}${mode === "dry-run" ? " (dry-run, not charged)" : ""}`,
        isDemo: ctx.demo,
      });
      ok++;
    } catch (e) {
      const msg = maskSecrets(e instanceof Error ? e.message : String(e));
      const [completed] = await db
        .update(listings)
        .set({
          status: "failed",
          publishError: msg,
          publishAttemptedAt: ctx.now,
          ...(e instanceof PrintifyPublishError ? { printifyProductId: e.productId } : {}),
          updatedAt: ctx.now,
        })
        .where(claimWhere)
        .returning({ id: listings.id });
      if (!completed) {
        skipped++;
        log(`#${l.id} skipped: publish claim changed before recording failure`, "warn");
        continue;
      }
      log(`#${l.id} publish failed: ${msg}`, "error");
      failed++;
    }
  }
  if (ok) {
    await emit(db, {
      type: "listing.published",
      title: `${ok} listing${ok > 1 ? "s" : ""} published`,
      body: etsy.mode === "dry-run" ? "Dry-run: nothing was sent to Etsy or Printify" : "Sent to Etsy",
      severity: "success",
      href: "/products",
    }, ctx.demo);
  }
  if (failed) {
    await emit(db, { type: "listing.failed", title: `${failed} listing${failed > 1 ? "s" : ""} failed to publish`, severity: "error", href: "/products" }, ctx.demo);
  }
  const summary = `Published ${ok}, failed ${failed}${skipped ? `, skipped ${skipped} (same error within 24h)` : ""}${held ? `, held ${held} for operator reconciliation` : ""} (${etsy.mode})`;
  if (failed > 0) throw new Error(summary);
  if (held > 0) return stageResult(summary, "warning");
  return summary;
};
