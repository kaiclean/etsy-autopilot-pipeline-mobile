import { and, eq, sql } from "drizzle-orm";
import type { DB } from "@/db";
import { designBriefs, designs, ideaCandidates, keywords, listings, orders } from "@/db/schema";
import { notFakeReceiptWhere, realPublishedListingsWhere, revenueEligibleOrderWhere } from "@/lib/real-orders";

export type FirstSale = {
  demo: boolean;
  keywordsNew: number; keywordsSelected: number; briefs: number;
  designsGenerated: number; designsNeedReview: number;
  pendingApproval: number; qualityHeld: number; approved: number;
  live: number; dryRunPublished: number;
  orders: number; revenueChf: number; profitChf: number;
  candidates: number;
  /** 0-5: furthest stage reached on the road to the first real sale. */
  stage: number;
};

const n = (v: unknown) => Number(v ?? 0);

/** Counts per stage for the first-sale tracker. Live counts exclude demo rows and dry-run/fake ids. */
export async function getFirstSale(db: DB, shopId: string, demo: boolean): Promise<FirstSale> {
  const kw = await db.select({ status: keywords.status, c: sql<number>`count(*)::int` }).from(keywords)
    .where(and(eq(keywords.shopId, shopId), eq(keywords.isDemo, demo))).groupBy(keywords.status);
  const k = Object.fromEntries(kw.map((r) => [r.status, n(r.c)]));
  const [{ c: briefs }] = await db.select({ c: sql<number>`count(*)::int` }).from(designBriefs).where(eq(designBriefs.shopId, shopId));
  const ds = await db.select({ status: designs.status, c: sql<number>`count(*)::int` }).from(designs)
    .where(and(eq(designs.shopId, shopId), eq(designs.isDemo, demo))).groupBy(designs.status);
  const d = Object.fromEntries(ds.map((r) => [r.status, n(r.c)]));
  const ls = await db.select({ status: listings.status, mode: listings.publishMode, c: sql<number>`count(*)::int` }).from(listings)
    .where(and(eq(listings.shopId, shopId), eq(listings.isDemo, demo))).groupBy(listings.status, listings.publishMode);
  const l = (s: string) => ls.filter((r) => r.status === s).reduce((a, r) => a + n(r.c), 0);
  const [{ c: live }] = await db.select({ c: sql<number>`count(*)::int` }).from(listings).where(realPublishedListingsWhere(shopId));
  const [o] = await db.select({ c: sql<number>`count(*)::int`, rev: sql<number>`coalesce(sum(${orders.totalChf}),0)`, profit: sql<number>`coalesce(sum(${orders.profitChf}),0)` })
    .from(orders).where(and(eq(orders.shopId, shopId), eq(orders.isDemo, false), notFakeReceiptWhere(), revenueEligibleOrderWhere()));
  const [{ c: candidates }] = await db.select({ c: sql<number>`count(*)::int` }).from(ideaCandidates).where(eq(ideaCandidates.status, "pending"));
  const r: FirstSale = {
    demo, keywordsNew: k.new ?? 0, keywordsSelected: k.selected ?? 0, briefs: n(briefs),
    designsGenerated: (d.generated ?? 0) + (d.listed ?? 0), designsNeedReview: d.needs_review ?? 0,
    pendingApproval: l("pending_approval"), qualityHeld: l("quality_failed"), approved: l("approved") + l("pod_created") + l("publishing"),
    live: n(live), dryRunPublished: ls.filter((x) => x.status === "published" && x.mode !== "live").reduce((a, x) => a + n(x.c), 0),
    orders: n(o?.c), revenueChf: n(o?.rev), profitChf: n(o?.profit), candidates: n(candidates), stage: 0,
  };
  r.stage = r.orders > 0 ? 5 : r.live > 0 ? 4 : r.approved > 0 ? 3 : r.pendingApproval > 0 ? 2 : r.designsGenerated > 0 ? 1 : 0;
  return r;
}

export const FIRST_SALE_NEXT = [
  "Approve an idea or candidate so the pipeline has a confirmed phrase to design.",
  "Designs exist; the listing stage drafts them into the approval queue.",
  "Open each pending listing, check the real file against its manifest and approve it.",
  "Approved listings publish only when you switch publish mode to live yourself (and Etsy identity verification has cleared).",
  "Live on Etsy. Watch views vs favorites; the weekly health report suggests the next fix.",
  "First sale made. Copy the winner's pattern to new listings; don't change the winner.",
];
