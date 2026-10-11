import { and, eq, isNotNull } from "drizzle-orm";
import type { DB } from "@/db";
import { approvalItems, listings, shops } from "@/db/schema";
import { boardFrom } from "@/lib/spend-cap";
import { buildPinCopy } from "@/lib/pin-copy";
import type { StageFn } from "@/pipeline/types";
import { pinterestAccessTier, pinterestAccessToken, pinterestWriteAllowed } from "./access";
import { s3PinImage } from "./image";

export type PinPayload = {
  title: string;
  description: string;
  altText: string;
  board: string;
  imageUrl: string | null;
  destinationLink: string;
  access: "trial" | "standard";
  etsyListingId: string;
  quality: string[];
};

function boardFor(config: unknown) {
  return boardFrom(config) ?? (process.env.PINTEREST_BOARD_ID?.trim() || "Etsy listings");
}

export function pinQuality(payload: Pick<PinPayload, "title" | "description" | "altText" | "imageUrl" | "destinationLink">) {
  const issues: string[] = [];
  if (!payload.title.trim() || payload.title.length > 100) issues.push("Title must be 1–100 characters.");
  if (!payload.description.trim() || payload.description.length > 500) issues.push("Description must be 1–500 characters.");
  if (!payload.altText.trim() || payload.altText.length > 500) issues.push("Alt text must be 1–500 characters.");
  if (!payload.imageUrl) issues.push("Image is not in S3 yet.");
  if (!payload.destinationLink.startsWith("https://www.etsy.com/listing/")) issues.push("Destination link is missing.");
  return issues;
}

async function pinterestBusiness(db: DB, shopId: string) {
  const [shop] = await db.select().from(shops).where(eq(shops.id, shopId));
  if (!shop || shop.kind !== "pinterest") return null;
  return shop;
}

/** One dry-run pin draft per active parent listing that already has an Etsy listing id. */
export const runPinterestDrafts: StageFn = async (ctx) => {
  const shop = await pinterestBusiness(ctx.db, ctx.shopId);
  if (!shop?.parentId) return "Pinterest business has no parent Etsy business.";
  const board = boardFor(shop.config);
  const access = pinterestAccessTier();
  const rows = await ctx.db
    .select()
    .from(listings)
    .where(and(eq(listings.shopId, shop.parentId), eq(listings.status, "published"), isNotNull(listings.etsyListingId)));
  let drafted = 0;
  let existing = 0;
  for (const listing of rows) {
    const etsyListingId = listing.etsyListingId?.trim();
    if (!etsyListingId) continue;
    const copy = buildPinCopy({ title: listing.title, description: listing.description, etsyListingId });
    const imageUrl = s3PinImage(listing.imageUrl) ?? s3PinImage(listing.deliveryUrl);
    const payload: PinPayload = {
      title: copy.title,
      description: copy.description,
      altText: copy.altText,
      board,
      imageUrl,
      destinationLink: copy.link,
      access,
      etsyListingId,
      quality: [],
    };
    payload.quality = pinQuality(payload);
    const [created] = await ctx.db
      .insert(approvalItems)
      .values({
        shopId: shop.id,
        listingId: listing.id,
        action: "pin",
        status: "pending_approval",
        payload,
        updatedAt: ctx.now,
      })
      .onConflictDoNothing({ target: [approvalItems.shopId, approvalItems.listingId, approvalItems.action] })
      .returning({ id: approvalItems.id });
    if (created) {
      drafted++;
      ctx.log(`Drafted pin for listing #${listing.id} on board “${board}” (${access}, dry-run)`);
    } else {
      existing++;
    }
  }
  return `Drafted ${drafted} pin${drafted === 1 ? "" : "s"}, ${existing} already queued (dry-run, no Pinterest API write).`;
};

/** Sends approved pins only when the business is confirmed live, a token is set, and access is Standard. */
export const runPinterestPublish: StageFn = async (ctx) => {
  const shop = await pinterestBusiness(ctx.db, ctx.shopId);
  if (!shop) return "Not a Pinterest business.";
  const access = pinterestAccessTier();
  const token = pinterestAccessToken();
  const decision = pinterestWriteAllowed({ accessToken: token, publishMode: shop.publishMode, access });
  const approved = await ctx.db
    .select()
    .from(approvalItems)
    .where(and(eq(approvalItems.shopId, shop.id), eq(approvalItems.action, "pin"), eq(approvalItems.status, "approved")));
  if (!decision.ok || !token) {
    const reason = decision.ok ? "PINTEREST_ACCESS_TOKEN is unset" : decision.reason;
    ctx.log(`No Pinterest API write: ${reason}.`);
    return `Approved pins stay queued (${approved.length}). ${reason}.`;
  }
  let sent = 0;
  let failed = 0;
  for (const item of approved) {
    const payload = (item.payload ?? {}) as PinPayload;
    const issues = pinQuality({
      title: String(payload.title ?? ""),
      description: String(payload.description ?? ""),
      altText: String(payload.altText ?? ""),
      imageUrl: payload.imageUrl ? String(payload.imageUrl) : null,
      destinationLink: String(payload.destinationLink ?? ""),
    });
    if (issues.length) {
      failed++;
      ctx.log(`Pin #${item.id} held: ${issues.join(" ")}`, "warn");
      continue;
    }
    try {
      const pinId = await createPin(token, {
        board: String(payload.board),
        title: String(payload.title),
        description: String(payload.description),
        altText: String(payload.altText),
        link: String(payload.destinationLink),
        imageUrl: String(payload.imageUrl),
      });
      await ctx.db
        .update(approvalItems)
        .set({ status: "published", payload: { ...payload, pinId }, updatedAt: new Date() })
        .where(eq(approvalItems.id, item.id));
      sent++;
      ctx.log(`Pin #${item.id} created (${pinId}).`);
    } catch (error) {
      failed++;
      const message = error instanceof Error ? error.message : "Pinterest pin create failed";
      ctx.log(`Pin #${item.id} failed: ${message}`, "error");
    }
  }
  if (failed > 0 && sent === 0) throw new Error(`Pinned 0, failed ${failed} (standard)`);
  return `Pinned ${sent}, failed ${failed} (standard)`;
};

async function createPin(
  token: string,
  pin: { board: string; title: string; description: string; altText: string; link: string; imageUrl: string },
) {
  const res = await fetch("https://api.pinterest.com/v5/pins", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      board_id: pin.board,
      title: pin.title,
      description: pin.description,
      alt_text: pin.altText,
      link: pin.link,
      media_source: { source_type: "image_url", url: pin.imageUrl },
    }),
  });
  if (!res.ok) throw new Error(`Pinterest pin create failed (${res.status})`);
  const json = (await res.json()) as { id?: string };
  if (!json.id) throw new Error("Pinterest pin create failed (missing id)");
  return String(json.id);
}
