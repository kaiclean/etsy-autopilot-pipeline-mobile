import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getImageProvider } from "@/adapters/image";
import { costs, designs, keywords } from "@/db/schema";
import { persistableImageUrl } from "@/lib/compact-image-url";
import { isDemoMode } from "@/lib/config";
import { emit } from "@/lib/events";
import { isNichePaused, NICHES } from "@/lib/niches";
import { getSetting } from "@/lib/settings";
import type { StageFn } from "./types";

export async function aiSpend(db: Parameters<StageFn>[0]["db"], since: Date) {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${costs.amountChf}), 0)::float` })
    .from(costs)
    .where(and(gte(costs.createdAt, since), sql`${costs.kind} in ('ai_image','ai_text')`));
  return Number(row?.total ?? 0);
}

export function buildPrompt(phrase: string, style: string) {
  return `${style}. Subject: ${phrase}. Original composition, high detail, opaque background, not transparent, no text, no lettering, no logos, no brand names, no trademarked characters.`;
}

export const runDesign: StageFn = async (ctx) => {
  const { db, log } = ctx;
  const automation = await getSetting(db, "automation");
  const provider = getImageProvider();
  log(`Image provider: ${provider.name} (est. CHF ${provider.estimatedCostChf.toFixed(2)}/image)`);

  let queue = await db
    .select()
    .from(keywords)
    .where(eq(keywords.status, "selected"))
    .orderBy(desc(keywords.score))
    .limit(automation.designsPerRun);
  if (queue.length === 0) {
    queue = await db.select().from(keywords).where(eq(keywords.status, "new")).orderBy(desc(keywords.score)).limit(automation.designsPerRun);
    if (queue.length) log("No selected keywords; falling back to top-scored backlog");
  }
  if (queue.length === 0) return "No keywords to design for. Run Research first.";

  const dayStart = new Date(ctx.now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const monthStart = new Date(Date.UTC(ctx.now.getUTCFullYear(), ctx.now.getUTCMonth(), 1));
  let spentToday = await aiSpend(db, dayStart);
  let spentMonth = await aiSpend(db, monthStart);

  let made = 0;
  for (const kw of queue) {
    if (spentToday + provider.estimatedCostChf > automation.dailyAiCapChf) {
      log(`Daily AI cap reached (CHF ${spentToday.toFixed(2)} / ${automation.dailyAiCapChf}); stopping`, "warn");
      break;
    }
    if (spentMonth + provider.estimatedCostChf > automation.monthlyAiBudgetChf) {
      log(`Monthly AI budget reached (CHF ${automation.monthlyAiBudgetChf}); stopping`, "warn");
      break;
    }
    if (isNichePaused(kw.niche)) {
      await db.update(keywords).set({ status: "rejected", updatedAt: ctx.now }).where(eq(keywords.id, kw.id));
      log(`Skipped “${kw.phrase}”: ${NICHES[kw.niche].pausedReason}`, "warn");
      continue;
    }
    const niche = NICHES[kw.niche];
    const prompt = buildPrompt(kw.phrase, niche.style);
    try {
      const img = await provider.generate({
        prompt,
        niche: kw.niche,
        seed: Math.floor(ctx.random() * 1e9),
        aspectRatio: kw.niche === "stream" ? "16:9" : "2:3",
        label: kw.phrase,
      });
      const imageUrl = await persistableImageUrl(img.url);
      await db.insert(designs).values({
        keywordId: kw.id,
        niche: kw.niche,
        prompt,
        provider: img.provider,
        imageUrl,
        costChf: img.costChf,
        isDemo: isDemoMode(),
      });
      if (img.costChf > 0) {
        await db.insert(costs).values({ kind: "ai_image", amountChf: img.costChf, note: `${img.provider}: ${kw.phrase}`, isDemo: isDemoMode() });
      }
      spentToday += img.costChf;
      spentMonth += img.costChf;
      await db.update(keywords).set({ status: "used", updatedAt: ctx.now }).where(eq(keywords.id, kw.id));
      made++;
      log(`Generated design for “${kw.phrase}”`);
    } catch (e) {
      log(`Generation failed for “${kw.phrase}”: ${(e as Error).message}`, "error");
    }
  }
  if (made) {
    await emit(db, { type: "design.generated", title: `${made} new design${made > 1 ? "s" : ""} generated`, severity: "info", href: "/pipeline" });
  }
  return `Generated ${made}/${queue.length} designs · AI spend today CHF ${spentToday.toFixed(2)}`;
};
