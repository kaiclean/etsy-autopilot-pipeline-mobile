import { eq, inArray } from "drizzle-orm";
import { getEtsyAdapter } from "@/adapters/etsy";
import { getPrintifyAdapter } from "@/adapters/printify";
import { PrintifyPublishError } from "@/adapters/printify/client";
import { costs, designs, listings } from "@/db/schema";
import { isDemoMode, publicAppUrl } from "@/lib/config";
import { emit } from "@/lib/events";
import { ETSY_FILE_LIMITS, validateForPublish } from "@/lib/deliverables";
import { FEES, round2, type PodPreset } from "@/lib/fees";
import { fetchPrintifyMockupUrl, printArtworkUrl } from "./mockup";
import type { StageFn } from "./types";

function podPreset(provider: string | null): PodPreset | undefined {
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

export const runPublish: StageFn = async (ctx) => {
  const { db, log } = ctx;
  const approved = await db
    .select()
    .from(listings)
    .where(inArray(listings.status, ["approved", "failed"]))
    .limit(10);
  if (approved.length === 0) return "Nothing approved to publish.";

  const etsy = await getEtsyAdapter(db, ctx.random);
  const printify = await getPrintifyAdapter({ db, random: ctx.random });
  log(`Etsy adapter: ${etsy.mode} · Printify adapter: ${printify.mode}`);

  let ok = 0;
  let failed = 0;
  for (const l of approved) {
    const check = validateForPublish(l);
    if (!check.valid) {
      await db
        .update(listings)
        .set({ status: "pending_approval", validation: check.issues, updatedAt: ctx.now })
        .where(eq(listings.id, l.id));
      log(`#${l.id} failed validation at publish time; returned to queue`, "warn");
      failed++;
      continue;
    }
    try {
      let etsyListingId: string | null = null;
      let printifyProductId: string | null = null;
      if (l.productType === "digital") {
        const files = (l.deliverables ?? []).slice(0, ETSY_FILE_LIMITS.maxFiles);
        if (etsy.mode === "live" && files.some((f) => !f.stored)) {
          throw new Error("Print files were rendered without storage. Configure S3 or Vercel Blob; the next Produce run stores them, then publish again.");
        }
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
        const image = absoluteUrl(l.imageUrl);
        await etsy.uploadListingImage(listingId, image);
        if (files.length) {
          for (const f of files) await etsy.uploadListingFile(listingId, { name: f.name, url: f.url });
        } else {
          await etsy.uploadListingFile(listingId, { name: `listing-${l.id}.png`, url: image });
        }
        // Live listings stay drafts unless ETSY_ACTIVATE=true. Etsy has no API for the
        // “How it’s made” / AI-tools field, and Kai’s clearance was drafts only.
        const activateLive = process.env.ETSY_ACTIVATE === "true";
        if (etsy.mode === "dry-run" || activateLive) await etsy.activateListing(listingId);
        etsyListingId = listingId;
        const state = etsy.mode === "live" && activateLive ? "active" : "draft";
        log(`#${l.id} → Etsy ${state} ${listingId} (${etsy.mode})`);
      } else {
        let artwork = l.imageUrl;
        if (l.designId) {
          const [design] = await db.select({ imageUrl: designs.imageUrl }).from(designs).where(eq(designs.id, l.designId));
          artwork = printArtworkUrl(l.imageUrl, design?.imageUrl);
        }
        const result = await printify.createAndPublish({
          title: l.title,
          description: l.description,
          tags: l.tags,
          priceChf: l.priceChf,
          imageUrl: absoluteUrl(artwork),
          preset: podPreset(l.podProvider),
          existingProductId: reusableId(l.printifyProductId, printify.mode, "dry-"),
        });
        const mockup = await fetchPrintifyMockupUrl(result.productId);
        if (mockup) {
          await db.update(listings).set({ imageUrl: mockup, updatedAt: ctx.now }).where(eq(listings.id, l.id));
        }
        printifyProductId = result.productId;
        // Printify creates the Etsy listing asynchronously; in dry-run we mint a synthetic id so orders can link.
        etsyListingId = result.externalEtsyId ?? (printify.mode === "dry-run" ? `dry-etsy-${result.productId}` : l.etsyListingId);
        log(`#${l.id} → Printify product ${result.productId}, published to Etsy (${printify.mode})`);
      }
      const mode = l.productType === "digital" ? etsy.mode : printify.mode;
      await db
        .update(listings)
        .set({
          status: "published",
          etsyListingId,
          printifyProductId,
          publishMode: mode,
          publishError: null,
          publishedAt: ctx.now,
          updatedAt: ctx.now,
        })
        .where(eq(listings.id, l.id));
      await db.insert(costs).values({
        kind: "listing_fee",
        amountChf: round2(FEES.listingFeeUsd * FEES.usdToChf * (1 + FEES.vatOnFeesRate)),
        note: `Listing fee #${l.id}${mode === "dry-run" ? " (dry-run, not charged)" : ""}`,
        isDemo: isDemoMode(),
      });
      ok++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await db
        .update(listings)
        .set({
          status: "failed",
          publishError: msg,
          ...(e instanceof PrintifyPublishError ? { printifyProductId: e.productId } : {}),
          updatedAt: ctx.now,
        })
        .where(eq(listings.id, l.id));
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
    });
  }
  if (failed) {
    await emit(db, { type: "listing.failed", title: `${failed} listing${failed > 1 ? "s" : ""} failed to publish`, severity: "error", href: "/products" });
  }
  const summary = `Published ${ok}, failed ${failed} (${etsy.mode})`;
  if (failed > 0) throw new Error(summary);
  return summary;
};
