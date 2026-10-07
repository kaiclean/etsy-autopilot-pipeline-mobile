import { and, eq, inArray, or, sql } from "drizzle-orm";
import sharp from "sharp";
import { getUpscaler } from "@/adapters/upscale";
import { costs, designs, listings, type Deliverable } from "@/db/schema";
import { isDemoMode, publicAppUrl } from "@/lib/config";
import { getDeliverableStore } from "@/lib/deliverable-store";
import { PACK_MAX_BYTES, PRINT_PACK_NICHES, PRINT_SPECS, validateForPublish, withPrintPackCopy } from "@/lib/deliverables";
import { emit } from "@/lib/events";
import { decodeDataUrl } from "@/lib/object-storage";
import { localAssetPng } from "@/lib/png";
import { renderPrintPack } from "@/lib/print-pack";
import { getSetting } from "@/lib/settings";
import { aiSpend } from "./design";
import type { StageFn } from "./types";

/** Each listing renders five large JPGs, so keep runs short. */
export const PRODUCE_PER_RUN = 3;

/** PRODUCE_SCALE shrinks every print size (tests and previews). Production leaves it unset. */
function packScale() {
  const v = Number(process.env.PRODUCE_SCALE);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : 1;
}

export async function loadArtwork(url: string): Promise<Buffer> {
  const local = localAssetPng(url);
  if (local) return local;
  if (url.startsWith("data:")) {
    const decoded = decodeDataUrl(url);
    if (!decoded) throw new Error("Unreadable data URL");
    return decoded.bytes;
  }
  const absolute = /^https?:\/\//i.test(url) ? url : new URL(url, `${publicAppUrl()}/`).toString();
  const res = await fetch(absolute);
  if (!res.ok) throw new Error(`Could not download artwork: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export const runProduce: StageFn = async (ctx) => {
  const { db, log } = ctx;
  const store = getDeliverableStore();
  // New wall-art downloads, plus, once storage exists, any listing whose files were only measured.
  const needsFiles = and(eq(listings.status, "pending_approval"), sql`jsonb_array_length(${listings.deliverables}) = 0`);
  const needsStoring =
    store.kind === "object-storage"
      ? and(inArray(listings.status, ["pending_approval", "approved", "failed"]), sql`${listings.deliverables} @> '[{"stored": false}]'::jsonb`)
      : undefined;
  const todo = await db
    .select()
    .from(listings)
    .where(and(eq(listings.productType, "digital"), inArray(listings.niche, [...PRINT_PACK_NICHES]), needsStoring ? or(needsFiles, needsStoring) : needsFiles))
    .limit(PRODUCE_PER_RUN);
  if (todo.length === 0) return "No wall-art downloads waiting for print files.";

  const automation = await getSetting(db, "automation");
  const upscaler = getUpscaler();
  const scale = packScale();
  log(`Upscaler: ${upscaler.name} · storage: ${store.kind}${scale < 1 ? ` · scale ${scale}` : ""}`);
  if (store.kind === "dry-run") log("No S3 or Blob configured: files are rendered and measured, not stored. Live publishing needs storage.", "warn");

  const dayStart = new Date(ctx.now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const monthStart = new Date(Date.UTC(ctx.now.getUTCFullYear(), ctx.now.getUTCMonth(), 1));
  let spentToday = await aiSpend(db, dayStart);
  let spentMonth = await aiSpend(db, monthStart);

  let made = 0;
  for (const l of todo) {
    if (upscaler.estimatedCostChf > 0) {
      if (spentToday + upscaler.estimatedCostChf > automation.dailyAiCapChf) {
        log(`Daily AI cap reached (CHF ${spentToday.toFixed(2)} / ${automation.dailyAiCapChf}); stopping`, "warn");
        break;
      }
      if (spentMonth + upscaler.estimatedCostChf > automation.monthlyAiBudgetChf) {
        log(`Monthly AI budget reached (CHF ${automation.monthlyAiBudgetChf}); stopping`, "warn");
        break;
      }
    }
    try {
      let artworkUrl = l.imageUrl;
      if (l.designId) {
        const [d] = await db.select({ imageUrl: designs.imageUrl }).from(designs).where(eq(designs.id, l.designId));
        if (d?.imageUrl) artworkUrl = d.imageUrl;
      }
      const src = await loadArtwork(artworkUrl);
      const meta = await sharp(src).metadata();
      if (!meta.width || !meta.height) throw new Error("Artwork has no readable size");
      const need = Math.max(...PRINT_SPECS.map((s) => Math.max((s.width * scale) / meta.width!, (s.height * scale) / meta.height!)));
      const enlarged = await upscaler.enlarge(src, need);
      const files = await renderPrintPack(enlarged.bytes, { scale, maxBytes: PACK_MAX_BYTES });
      const deliverables: Deliverable[] = [];
      for (const f of files) {
        const kept = await store.put(f.name, f.bytes, "image/jpeg");
        deliverables.push({
          name: f.name,
          ratio: f.spec.ratio,
          width: f.width,
          height: f.height,
          bytes: f.bytes.length,
          url: kept.url,
          stored: kept.stored,
          method: enlarged.method,
          // Interpolated stretch only: after model upscaling the renderer's input is the model output.
          upscale: Math.round(f.upscale * 100) / 100,
        });
      }
      const description = withPrintPackCopy(l.description, deliverables) ?? l.description;
      if (description === l.description && l.deliverables.length === 0) log(`#${l.id}: description was edited, so the file list was not rewritten`, "warn");
      const { issues } = validateForPublish({ ...l, description, deliverables });
      await db.update(listings).set({ deliverables, description, validation: issues, updatedAt: ctx.now }).where(eq(listings.id, l.id));
      if (enlarged.costChf > 0) {
        await db.insert(costs).values({ kind: "ai_image", amountChf: enlarged.costChf, note: `${upscaler.name}: listing #${l.id}`, isDemo: isDemoMode() });
        spentToday += enlarged.costChf;
        spentMonth += enlarged.costChf;
      }
      made++;
      const mb = (deliverables.reduce((a, d) => a + d.bytes, 0) / 1024 / 1024).toFixed(1);
      log(`#${l.id}: ${deliverables.length} print files, ${mb} MB, up to ${Math.max(...deliverables.map((d) => d.upscale)).toFixed(1)}× enlargement`);
    } catch (e) {
      log(`#${l.id} produce failed: ${(e as Error).message}`, "error");
    }
  }
  if (made) {
    await emit(db, { type: "files.produced", title: `Print files ready for ${made} listing${made > 1 ? "s" : ""}`, severity: "info", href: "/queue" });
  }
  return `Produced print files for ${made}/${todo.length} listings (${store.kind})`;
};
