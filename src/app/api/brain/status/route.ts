import { bearerMatches } from "@/lib/bearer";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/db";
import { config, isDemoMode } from "@/lib/config";
import { readPublishMode, liveWritesEnabled } from "@/lib/read-publish-mode";
import { getSetting } from "@/lib/settings";
import { resolveActiveShop } from "@/lib/shops";
import { getFirstSale } from "@/lib/brain/first-sale";
import { aiSpend } from "@/pipeline/design";

// Non-secret operational state for Hermes and agents: publish mode, spend caps, funnel counts.
// Exempt from the session check in proxy.ts; bearer OMNIGRAM_API_TOKEN instead. Never returns secrets.
export const dynamic = "force-dynamic";
const authorized = (req: NextRequest) => bearerMatches(req.headers.get("authorization"), process.env.OMNIGRAM_API_TOKEN);
let cache: { at: number; value: unknown } | null = null;
let inflight: Promise<unknown> | null = null;
/** 20 s cache + single flight: the funnel counts run ~20 queries, so polling agents must not multiply them. */
async function compute() {
  const db = await getDb();
  const automation = await getSetting(db, "automation");
  const now = new Date();
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const shop = await resolveActiveShop(db);
  const round = (v: number) => Math.round(v * 100) / 100;
  const [dashboardMode, writes, spentDay, spentMonth, firstSale] = await Promise.all([
    readPublishMode(db), liveWritesEnabled(db), aiSpend(db, day), aiSpend(db, month), getFirstSale(db, shop.id, isDemoMode(shop.id)),
  ]);
  return {
    publish: { dashboardMode, hostMode: config.publishMode, liveWritesEnabled: writes },
    image: { provider: config.imageProvider, fallbackProvider: config.imageFallbackProvider ?? null, llmProvider: config.llmProvider },
    budget: {
      dailyAiCapChf: automation.dailyAiCapChf, monthlyAiBudgetChf: automation.monthlyAiBudgetChf, designsPerRun: automation.designsPerRun,
      adsEnabled: automation.adsEnabled, dailyAdsCapChf: automation.dailyAdsCapChf,
      aiSpentTodayChf: round(spentDay), aiSpentMonthChf: round(spentMonth),
    },
    firstSale,
    at: now.toISOString(),
  };
}
export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const now = Date.now();
  if (!cache || now - cache.at > 20_000) {
    inflight ??= compute().then((value) => { cache = { at: Date.now(), value }; return value; }).finally(() => { inflight = null; });
    await inflight;
  }
  return NextResponse.json(cache!.value, { headers: { "cache-control": "no-store" } });
}
