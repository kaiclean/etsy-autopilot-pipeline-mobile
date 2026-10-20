import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { and, count, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { designs, listings, orders } from "@/db/schema";
import { config, isDemoMode } from "@/lib/config";
import { readPublishMode, liveWritesEnabled } from "@/lib/read-publish-mode";
import { getSetting } from "@/lib/settings";
import { resolveActiveShop } from "@/lib/shops";
import { getFirstSale } from "@/lib/brain/first-sale";
import { aiSpend } from "@/pipeline/design";

// Non-secret operational state for Hermes and agents: publish mode, spend caps, funnel counts.
// Exempt from the session check in proxy.ts; bearer OMNIGRAM_API_TOKEN instead. Never returns secrets.
export const dynamic = "force-dynamic";
function authorized(req: NextRequest) {
  const want = process.env.OMNIGRAM_API_TOKEN;
  const got = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!want || !got) return false;
  const a = Buffer.from(got), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}
export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = await getDb();
  const automation = await getSetting(db, "automation");
  const now = new Date();
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const shop = await resolveActiveShop(db);
  const round = (v: number) => Math.round(v * 100) / 100;
  const tally = async (query: Promise<{ n: number }[]>) => Number((await query)[0]?.n ?? 0);
  const counts = {
    listings: await tally(db.select({ n: count() }).from(listings).where(eq(listings.isDemo, false))),
    // Drafts = unactivated listings still awaiting review or held by the gates.
    drafts: await tally(db.select({ n: count() }).from(listings).where(and(eq(listings.isDemo, false), isNull(listings.activatedAt), inArray(listings.status, ["pending_approval", "quality_failed"])))),
    orders: await tally(db.select({ n: count() }).from(orders).where(eq(orders.isDemo, false))),
    designs: await tally(db.select({ n: count() }).from(designs).where(eq(designs.isDemo, false))),
  };
  return NextResponse.json({
    publishMode: config.publishMode,
    counts,
    publish: { dashboardMode: await readPublishMode(db), hostMode: config.publishMode, liveWritesEnabled: await liveWritesEnabled(db) },
    image: { provider: config.imageProvider, fallbackProvider: config.imageFallbackProvider ?? null, llmProvider: config.llmProvider },
    budget: {
      dailyAiCapChf: automation.dailyAiCapChf, monthlyAiBudgetChf: automation.monthlyAiBudgetChf, designsPerRun: automation.designsPerRun,
      adsEnabled: automation.adsEnabled, dailyAdsCapChf: automation.dailyAdsCapChf,
      aiSpentTodayChf: round(await aiSpend(db, day)), aiSpentMonthChf: round(await aiSpend(db, month)),
    },
    firstSale: await getFirstSale(db, shop.id, isDemoMode(shop.id)),
    at: now.toISOString(),
  });
}
