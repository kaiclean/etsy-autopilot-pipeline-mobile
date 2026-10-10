import { and, eq, inArray, isNull } from "drizzle-orm";
import type { DB } from "@/db";
import { costs, designBriefs, designs } from "@/db/schema";
import type { LLMProvider } from "@/adapters/llm/types";
import { assessArtwork } from "@/lib/design-quality";
import { preparePrintFile } from "@/pipeline/artwork";
import { isPlaceholderUrl } from "@/lib/art-quality";

/** Explicit operator recovery only: never approves listings or touches publishing. */
export async function reassessDesigns(db: DB, ids: number[], vision: LLMProvider, apply = false) {
  if (!ids.length || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error("Provide positive design IDs");
  if (!vision.assessImage) throw new Error("Vision model is unavailable");
  const pending = await db.select().from(designs).where(and(
    inArray(designs.id, ids), eq(designs.isDemo, false), isNull(designs.qualityScore),
    inArray(designs.status, ["generated", "rejected", "needs_review"]),
  ));
  const report: Array<{ id: number; status: string; reasons: string[] }> = [];
  for (const design of pending) {
    let score: number | null = null;
    let status: typeof designs.$inferSelect.status = "needs_review";
    let reasons = ["Vision assessment unavailable; human image review required."];
    let prepared: Awaited<ReturnType<typeof preparePrintFile>> = { url: design.imageUrl, width: null, height: null, variance: null };
    try {
      prepared = await preparePrintFile(design.imageUrl);
      if (isPlaceholderUrl(design.imageUrl) || design.provider === "mock") throw new Error("Placeholder art");
      const preview = prepared.visionPreview ?? (design.imageUrl.startsWith("https://") ? design.imageUrl : null);
      if (!preview) throw new Error("Vision preview unavailable");
      const assessment = await vision.assessImage(preview);
      const [brief] = design.keywordId == null ? [] : await db.select().from(designBriefs).where(and(eq(designBriefs.keywordId, design.keywordId), eq(designBriefs.shopId, design.shopId))).limit(1);
      const print = !brief || (brief.productType === "pod" && brief.podPreset === "posterA3");
      const check = assessArtwork(assessment, prepared.width, prepared.height, print, prepared.variance);
      score = assessment.score;
      status = check.pass ? "generated" : "rejected";
      reasons = check.reasons;
      if (assessment.costChf && assessment.costChf > 0) await db.insert(costs).values({
        shopId: design.shopId, kind: "ai_text", amountChf: assessment.costChf,
        note: `${vision.name}: re-assessment design #${design.id}`, isDemo: false,
      });
    } catch {
      // Keep unassessed art off Listing even if the provider cannot inspect it.
    }
    if (apply) await db.update(designs).set({
      qualityScore: score, qualityReasons: reasons, status,
      imageWidth: prepared.width, imageHeight: prepared.height, colorVariance: prepared.variance,
    }).where(and(eq(designs.id, design.id), isNull(designs.qualityScore), inArray(designs.status, ["generated", "rejected", "needs_review"])));
    report.push({ id: design.id, status, reasons });
  }
  return report;
}
