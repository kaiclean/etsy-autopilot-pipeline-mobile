import { and, desc, eq, isNotNull, isNull, lt, not, or, sql, like } from "drizzle-orm";
import { getPinterestAdapter, pinterestEnv, type PinterestAdapter } from "@/adapters/pinterest";
import type { PinImage } from "@/adapters/pinterest/types";
import type { DB } from "@/db";
import { listings, promotions } from "@/db/schema";
import { publicAppUrl } from "@/lib/config";
import { emit } from "@/lib/events";
import { buildPinCopy } from "@/lib/pin-copy";
import { localAssetPng } from "@/lib/png";
import type { StageFn } from "./types";

/** A few pins a day reads as a shop, not a bot. */
export const PROMOTE_PER_RUN = 5;
export const MAX_PIN_ATTEMPTS = 3;
/** A claim older than this was abandoned mid-run and may be taken again. */
const STALE_CLAIM_MS = 15 * 60 * 1000;

function reclaimable(now: Date) {
  return or(
    and(eq(promotions.status, "failed"), lt(promotions.attempts, MAX_PIN_ATTEMPTS)),
    and(eq(promotions.status, "queued"), lt(promotions.updatedAt, new Date(now.getTime() - STALE_CLAIM_MS))),
  );
}

/** Claims one listing for pinning. Exactly one concurrent caller gets the row; the rest get null. */
export async function claimPromotion(db: DB, listingId: number, mode: "dry-run" | "live", now = new Date()) {
  const [created] = await db
    .insert(promotions)
    .values({ listingId, mode, status: "queued", updatedAt: now })
    .onConflictDoNothing({ target: promotions.listingId })
    .returning();
  if (created) return created;
  const [again] = await db
    .update(promotions)
    .set({ status: "queued", mode, updatedAt: now })
    .where(and(eq(promotions.listingId, listingId), reclaimable(now)))
    .returning();
  return again ?? null;
}

function pinImage(url: string): PinImage {
  const local = localAssetPng(url);
  if (local) return { kind: "base64", contentType: "image/png", data: local.toString("base64") };
  if (/^https?:\/\//i.test(url)) return { kind: "url", url };
  return { kind: "url", url: new URL(url, `${publicAppUrl()}/`).toString() };
}

export function makeRunPromote(getAdapter: (db: DB) => Promise<PinterestAdapter>): StageFn {
  return async (ctx) => {
    const { db, log } = ctx;
    const adapter = await getAdapter(db);
    const boardId = pinterestEnv().boardId ?? "dry-run-board";
    const liveOnly =
      adapter.mode === "live" ? and(eq(listings.publishMode, "live"), not(like(listings.etsyListingId, "dry-%"))) : undefined;
    const candidates = await db
      .select({ listing: listings })
      .from(listings)
      .leftJoin(promotions, eq(promotions.listingId, listings.id))
      .where(and(eq(listings.status, "published"), isNotNull(listings.etsyListingId), liveOnly, or(isNull(promotions.id), reclaimable(ctx.now))))
      .orderBy(sql`${listings.publishedAt} desc nulls last`, desc(listings.id))
      .limit(PROMOTE_PER_RUN);
    if (candidates.length === 0) return `Nothing new to pin (${adapter.mode}).`;
    log(`Pinterest adapter: ${adapter.mode}${adapter.mode === "dry-run" ? " (nothing is sent)" : ""}`);

    let ok = 0;
    let failed = 0;
    for (const { listing: l } of candidates) {
      const claim = await claimPromotion(db, l.id, adapter.mode, ctx.now);
      if (!claim) continue;
      try {
        const copy = buildPinCopy({ title: l.title, description: l.description, etsyListingId: l.etsyListingId! });
        const { pinId } = await adapter.createPin({ boardId, ...copy, image: pinImage(l.imageUrl) });
        await db
          .update(promotions)
          .set({ status: "posted", pinId, error: null, attempts: sql`${promotions.attempts} + 1`, updatedAt: new Date() })
          .where(eq(promotions.id, claim.id));
        ok++;
        log(`#${l.id} pinned (${pinId})`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await db
          .update(promotions)
          .set({ status: "failed", error: msg.slice(0, 500), attempts: sql`${promotions.attempts} + 1`, updatedAt: new Date() })
          .where(eq(promotions.id, claim.id));
        failed++;
        log(`#${l.id} pin failed: ${msg}`, "error");
      }
    }
    if (ok) {
      await emit(db, {
        type: "listing.promoted",
        title: `${ok} listing${ok > 1 ? "s" : ""} pinned to Pinterest`,
        body: adapter.mode === "dry-run" ? "Dry-run: nothing was sent to Pinterest" : "Check the board; Trial-access pins are visible only to you",
        severity: "success",
        href: "/products",
      });
    }
    const summary = `Pinned ${ok}, failed ${failed} (${adapter.mode})`;
    if (failed > 0 && ok === 0) throw new Error(summary);
    return summary;
  };
}

export const runPromote: StageFn = makeRunPromote(getPinterestAdapter);
