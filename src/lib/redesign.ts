import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import { costs, designs } from "@/db/schema";
import { getImageProvider } from "@/adapters/image";
import { getSetting } from "@/lib/settings";
import { preparePrintFile } from "@/pipeline/artwork";
import { PRINT_RENDER, aiSpend } from "@/pipeline/design";

/**
 * Re-render a flagged design from its OWN original prompt at 4:5 1024×1280 with the print model.
 * Stores the new clean source and leaves upscaleMethod null so the box worker runs one 4× Real-ESRGAN pass;
 * the flag is cleared by the upscale-complete route once the result meets the target.
 */
export async function regenerateFlaggedDesign(db: DB, id: number, log: (msg: string) => void = console.log) {
  const [design] = await db.select().from(designs).where(eq(designs.id, id));
  if (!design) throw new Error(`design #${id} not found`);
  if (!design.needsRedesign) throw new Error(`design #${id} is not flagged for redesign`);
  const automation = await getSetting(db, "automation");
  const now = new Date();
  const spent = await aiSpend(db, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())));
  const provider = getImageProvider();
  if (spent + provider.estimatedCostChf > automation.dailyAiCapChf) throw new Error(`daily AI cap CHF ${automation.dailyAiCapChf} reached (spent ${spent.toFixed(2)})`);
  const img = await provider.generate({ prompt: design.prompt, niche: design.niche, seed: Math.floor(Math.random() * 1e9), aspectRatio: "4:5", ...PRINT_RENDER, label: `redesign #${id}`, print: true });
  if (img.costChf > 0) await db.insert(costs).values({ shopId: design.shopId, kind: "ai_image", amountChf: img.costChf, note: `${img.provider}: redesign #${id}`, isDemo: false });
  const measured = await preparePrintFile(img.url);
  if (!measured.width || !measured.height) throw new Error("re-rendered image could not be measured");
  if (measured.width < PRINT_RENDER.width || measured.height < PRINT_RENDER.height) {
    throw new Error(`re-render came back ${measured.width}×${measured.height}, below ${PRINT_RENDER.width}×${PRINT_RENDER.height}`);
  }
  await db.update(designs).set({
    imageUrl: img.url, sourceImageUrl: img.url, sourcePx: { width: measured.width, height: measured.height },
    imageWidth: measured.width, imageHeight: measured.height, upscaleMethod: null, outputPx: null, colorVariance: measured.variance,
  }).where(eq(designs.id, id));
  log(`[redesign] design #${id} re-rendered from its own prompt at ${measured.width}×${measured.height} (${img.provider}); queued for one 4× Real-ESRGAN pass`);
  return { id, url: img.url, width: measured.width, height: measured.height, provider: img.provider };
}
