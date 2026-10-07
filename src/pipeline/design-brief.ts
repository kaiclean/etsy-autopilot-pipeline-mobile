import { eq } from "drizzle-orm";
import { designBriefs, type Niche } from "@/db/schema";
import { utcDayKey } from "@/lib/utc-day";
import { productForPhrase } from "./listing";
import type { StageContext } from "./types";

/**
 * Stores the product choice and prompt once per keyword.
 * A second call on the same keyword returns the original brief.
 */
export async function ensureDesignBrief(
  ctx: StageContext,
  keyword: { id: number; phrase: string; niche: Niche },
  prompt: string,
) {
  const [existing] = await ctx.db.select().from(designBriefs).where(eq(designBriefs.keywordId, keyword.id)).limit(1);
  if (existing) return { brief: existing, created: false };

  const product = productForPhrase(keyword.niche, keyword.phrase, ctx.random());
  const [created] = await ctx.db
    .insert(designBriefs)
    .values({
      shopId: ctx.shopId,
      keywordId: keyword.id,
      niche: keyword.niche,
      prompt,
      productType: product.type,
      podPreset: product.pod ?? null,
      dayKey: utcDayKey(ctx.now),
      status: "briefed",
      isDemo: ctx.demo,
    })
    .onConflictDoNothing({ target: designBriefs.keywordId })
    .returning();
  if (created) return { brief: created, created: true };

  const [again] = await ctx.db.select().from(designBriefs).where(eq(designBriefs.keywordId, keyword.id)).limit(1);
  return { brief: again, created: false };
}
