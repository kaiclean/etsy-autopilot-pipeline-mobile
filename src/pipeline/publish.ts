import { eq } from "drizzle-orm";
import { getEtsyAdapter } from "@/adapters/etsy";
import { getPrintifyAdapter } from "@/adapters/printify";
import { costs, listings } from "@/db/schema";
import { isDemoMode } from "@/lib/config";
import { emit } from "@/lib/events";
import { FEES, round2 } from "@/lib/fees";
import { validateListing } from "@/lib/listing-validator";
import type { StageFn } from "./types";

export function absoluteUrl(url: string) {
  if (/^(https?:|data:)/.test(url)) return url;
  const base = process.env.APP_URL ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:4317");
  return new URL(url, base).toString();
}

export const runPublish: StageFn = async (ctx) => {
  const { db, log } = ctx;
  const approved = await db.select().from(listings).where(eq(listings.status, "approved")).limit(10);
  if (approved.length === 0) return "Nothing approved to publish.";

  const etsy = await getEtsyAdapter(db, ctx.random);
  const printify = getPrintifyAdapter({ random: ctx.random });
  log(`Etsy adapter: ${etsy.mode} · Printify adapter: ${printify.mode}`);

  let ok = 0;
  let failed = 0;
  for (const l of approved) {
    const check = validateListing(l);
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
        const { listingId } = await etsy.createDraftListing({
          title: l.title,
          description: l.description,
          priceChf: l.priceChf,
          tags: l.tags,
          type: "download",
        });
        await etsy.uploadListingImage(listingId, absoluteUrl(l.imageUrl));
        await etsy.uploadListingFile(listingId, { name: `listing-${l.id}.png`, url: absoluteUrl(l.imageUrl) });
        etsyListingId = listingId;
        log(`#${l.id} → Etsy draft ${listingId} (${etsy.mode})`);
      } else {
        const { productId, externalEtsyId } = await printify.createAndPublish({
          title: l.title,
          description: l.description,
          tags: l.tags,
          priceChf: l.priceChf,
          imageUrl: absoluteUrl(l.imageUrl),
        });
        printifyProductId = productId;
        // Printify creates the Etsy listing asynchronously; in dry-run we mint a synthetic id so orders can link.
        etsyListingId = externalEtsyId ?? (printify.mode === "dry-run" ? `dry-etsy-${productId}` : null);
        log(`#${l.id} → Printify product ${productId}, published to Etsy (${printify.mode})`);
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
      const msg = (e as Error).message;
      await db.update(listings).set({ status: "failed", publishError: msg, updatedAt: ctx.now }).where(eq(listings.id, l.id));
      log(`#${l.id} publish failed: ${msg}`, "error");
      failed++;
    }
  }
  if (ok) {
    await emit(db, {
      type: "listing.published",
      title: `${ok} listing${ok > 1 ? "s" : ""} published`,
      body: etsy.mode === "dry-run" ? "Dry-run: nothing was sent to Etsy/Printify" : "Live on Etsy as drafts: set the AI field and activate",
      severity: "success",
      href: "/products",
    });
  }
  if (failed) {
    await emit(db, { type: "listing.failed", title: `${failed} listing${failed > 1 ? "s" : ""} failed to publish`, severity: "error", href: "/products" });
  }
  return `Published ${ok}, failed ${failed} (${etsy.mode})`;
};
