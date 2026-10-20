import { and, count, eq, gte, isNull, like } from "drizzle-orm";
import type { DB } from "@/db";
import { costs, designs, listings } from "@/db/schema";
import { getImageProvider } from "@/adapters/image";
import { getSetting } from "@/lib/settings";
import { reserveImage } from "@/lib/image-quota";
import { preparePrintFile } from "@/pipeline/artwork";
import { PRINT_RENDER, aiSpend } from "@/pipeline/design";

/**
 * Re-render a flagged design from its OWN original prompt at 4:5 1024×1280 with the print model.
 * Stores the new clean source and leaves upscaleMethod null so the box worker runs one 4× Real-ESRGAN pass;
 * the flag is cleared by the upscale-complete route once the result meets the target.
 */
export { MAX_REDESIGNS_PER_DAY } from "@/lib/image-quota";

export async function regenerateFlaggedDesign(db: DB, id: number, log: (msg: string) => void = console.log, opts: { hint?: string } = {}) {
  const [design] = await db.select().from(designs).where(eq(designs.id, id));
  if (!design) throw new Error(`design #${id} not found`);
  if (!design.needsRedesign) throw new Error(`design #${id} is not flagged for redesign`);
  const automation = await getSetting(db, "automation");
  const now = new Date();
  const spent = await aiSpend(db, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())));
  const provider = getImageProvider();
  if (spent + provider.estimatedCostChf > automation.dailyAiCapChf) throw new Error(`daily AI cap CHF ${automation.dailyAiCapChf} reached (spent ${spent.toFixed(2)})`);
  // Count generations, not CHF (Cloudflare costs 0). Atomic, shared with daily runs.
  const slot = await reserveImage(db, { provider: provider.name, redesign: true });
  if (!slot.ok) throw new Error(slot.reason);
  const img = await provider.generate({ prompt: opts.hint ? `${design.prompt}, ${opts.hint}` : design.prompt, niche: design.niche, seed: Math.floor(Math.random() * 1e9), aspectRatio: "4:5", ...PRINT_RENDER, label: `redesign #${id}`, print: true });
  await db.insert(costs).values({ shopId: design.shopId, kind: "ai_image", amountChf: img.costChf, note: `redesign #${id} (${img.provider})`, isDemo: false });
  const measured = await preparePrintFile(img.url);
  if (!measured.width || !measured.height) throw new Error("re-rendered image could not be measured");
  if (measured.width < PRINT_RENDER.width || measured.height < PRINT_RENDER.height) {
    throw new Error(`re-render came back ${measured.width}×${measured.height}, below ${PRINT_RENDER.width}×${PRINT_RENDER.height}`);
  }
  // Blank-edge check on all four sides before anything else; a trimmed render must still meet 1024×1280.
  const { blankEdgeBands } = await import("@/lib/edge-check");
  const { decodeDataUrl } = await import("@/lib/object-storage");
  const raw = decodeDataUrl(img.url)?.bytes ?? Buffer.from(await (await fetch(img.url, { signal: AbortSignal.timeout(60_000) })).arrayBuffer());
  const bands = await blankEdgeBands(raw);
  log(`[redesign] design #${id} edge check: top ${bands.top} bottom ${bands.bottom} left ${bands.left} right ${bands.right}px`);
  if (bands.blank && (bands.trimmed.width < PRINT_RENDER.width || bands.trimmed.height < PRINT_RENDER.height)) {
    throw new Error(`re-render has blank edge bands (top ${bands.top}, bottom ${bands.bottom}, left ${bands.left}, right ${bands.right}px); trimmed ${bands.trimmed.width}×${bands.trimmed.height} is below ${PRINT_RENDER.width}×${PRINT_RENDER.height} — rejected`);
  }
  await db.update(designs).set({
    designReview: null,
    imageUrl: img.url, sourceImageUrl: img.url, sourcePx: { width: measured.width, height: measured.height },
    imageWidth: measured.width, imageHeight: measured.height, upscaleMethod: null, outputPx: null, colorVariance: measured.variance,
  }).where(eq(designs.id, id));
  // Every POD listing on this design goes back to review with stale mockups (the art changed).
  const pod = await db.select({ id: listings.id, validation: listings.validation }).from(listings)
    .where(and(eq(listings.designId, id), eq(listings.productType, "pod"), isNull(listings.activatedAt)));
  for (const row of pod) {
    const validation = [...(row.validation ?? []).filter((issue) => issue.code !== "mockups_stale"),
      { field: "image" as const, severity: "error" as const, code: "mockups_stale", message: "Artwork was re-rendered; supplier mockups must be regenerated before approval." }];
    await db.update(listings).set({ status: "quality_failed", validation, deliveryUrl: null, updatedAt: new Date() }).where(eq(listings.id, row.id));
  }
  log(`[redesign] design #${id} re-rendered from its own prompt at ${measured.width}×${measured.height} (${img.provider}); queued for one 4× Real-ESRGAN pass`);
  return { id, podListingsBackToReview: pod.map((row) => row.id), url: img.url, width: measured.width, height: measured.height, provider: img.provider };
}
