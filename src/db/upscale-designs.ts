import { inArray, eq } from "drizzle-orm";
import { pathToFileURL } from "node:url";
import type { DB } from "@/db";
import { getDb } from "@/db";
import { config, storageBackend } from "@/lib/config";
import { designBriefs, designs, listings, type FileManifest } from "@/db/schema";
import { defaultDeliverable, removeUndeliverablePromises } from "@/lib/delivery";
import { evaluateQualityGate, podPresetFromProvider } from "@/lib/quality-gate";
import { repairTrivialCopy, validateListing } from "@/lib/listing-validator";
import { buildFileManifest } from "@/lib/file-manifest";
import { digitalMidPrice } from "@/lib/pricing-ladder";
import { isPodPreset } from "@/lib/fees";
import { PRINT_TARGETS, getPrintTarget, type PrintTargetKey } from "@/lib/print-targets";
import { preparePrintFile } from "@/pipeline/artwork";
import { upscaleArtwork } from "@/pipeline/upscale";
import { designTarget, flagRedesign, reachableBy4x } from "@/lib/upscale-jobs";

async function measureSource(url: string) {
  const measured = await preparePrintFile(url).catch(() => null);
  return measured?.width && measured.height ? { width: measured.width, height: measured.height } : null;
}

type ReprocessedListing = {
  id: number;
  title: string;
  tags: string[];
  description: string;
  deliveryUrl: string | null;
  fileManifest: FileManifest | null;
  validation: ReturnType<typeof validateListing>["issues"];
  status: "pending_approval" | "quality_failed";
};

export async function upscaleDesigns(db: DB, ids: number[], apply = false, precomputed?: Map<number, Awaited<ReturnType<typeof upscaleArtwork>>>) {
  if (!ids.length || ids.some((id) => !Number.isInteger(id) || id < 1)) throw new Error("Provide one or more positive design IDs.");
  if (apply && storageBackend() === "none") throw new Error("Object storage is required for --apply; preview remains read-only.");
  const rows = await db.select({ design: designs, brief: designBriefs }).from(designs)
    .leftJoin(designBriefs, eq(designs.keywordId, designBriefs.keywordId))
    .where(inArray(designs.id, ids));
  const byId = new Map(rows.map((row) => [row.design.id, row]));
  const report = [];

  for (const id of ids) {
    const row = byId.get(id);
    if (!row) {
      report.push({ id, skipped: "Design not found." });
      continue;
    }
    const { design, brief } = row;
    if (design.status === "discarded") {
      report.push({ id, skipped: "Discarded designs are not reprocessed." });
      continue;
    }
    // Combined target across every product this design feeds (max of each dimension).
    const resolved = await designTarget(db, id);
    const targetKey: PrintTargetKey = resolved.key;
    const target = resolved.target;
    const pod = resolved.presets.length > 0;
    const fallbackTarget = targetKey === "digitalLarge" ? PRINT_TARGETS.digital : target;
    const sourceUrl = design.sourceImageUrl ?? design.imageUrl;
    let processed = precomputed?.get(id);
    if (!processed && pod) {
      // Measure the real source when sourcePx was never recorded, instead of skipping (stops the 422 loop).
      const sourcePx = design.sourcePx ?? await measureSource(sourceUrl);
      if (!sourcePx) {
        report.push({ id, skipped: "Source image could not be measured." });
        continue;
      }
      const reach = reachableBy4x(sourcePx, target);
      if (!reach.reachable) {
        await flagRedesign(db, { designId: id, sourcePx, presets: resolved.presets, target, scale: reach.scale });
        report.push({ id, skipped: `Needs full-size redesign: ${sourcePx.width}×${sourcePx.height} needs ${reach.scale}× for ${target.minW}×${target.minH}.` });
        continue;
      }
    }
    processed ??= await upscaleArtwork(sourceUrl, target, { fallbackTarget, store: apply, posterFinish: config.upscale.posterFinish && (targetKey === "posterA3" || targetKey === "canvas") });
    if (pod && processed.upscaleMethod !== "realesrgan") {
      // Print files are Real-ESRGAN only; the item stays held.
      report.push({ id, skipped: `Real-ESRGAN unavailable (${processed.upscaleMethod}); print stays held.` });
      continue;
    }
    const measured = await preparePrintFile(processed.url);
    if (!measured.width || !measured.height) throw new Error(`Design #${id}: reprocessed file could not be measured.`);
    const outputPx = { width: measured.width, height: measured.height };
    const listingRows = await db.select().from(listings).where(eq(listings.designId, id));
    const listingUpdates: ReprocessedListing[] = [];

    for (const listing of listingRows) {
      if ((listing.status !== "pending_approval" && listing.status !== "quality_failed") || listing.activatedAt) continue;
      const productPreset = podPresetFromProvider(listing.podProvider);
      const isLargeDigital = listing.productType === "digital" &&
        listing.priceChf >= digitalMidPrice(listing.niche);
      const listingTargetKey: PrintTargetKey = listing.productType === "digital"
        ? isLargeDigital ? "digitalLarge" : "digital"
        : productPreset ?? targetKey;
      const listingTarget = listing.productType === "digital" && isLargeDigital
        ? PRINT_TARGETS.digitalLarge
        : listing.productType === "digital"
          ? PRINT_TARGETS.digital
          : design.printTarget ?? PRINT_TARGETS[listingTargetKey];
      const deliverable = defaultDeliverable(
        listing.productType,
        listing.productType === "digital" ? "png" : null,
      );
      if (listing.productType === "pod" && productPreset === "ornament") deliverable.blank = "ornament";
      if (listing.productType === "digital") {
        deliverable.dpi = 300;
        deliverable.sizes = [`${(outputPx.width / 300).toFixed(1)}×${(outputPx.height / 300).toFixed(1)} in`];
      }
      const cleanLines = listing.description.split("\n")
        .map((line) => removeUndeliverablePromises(line, deliverable))
        .filter(Boolean);
      const repaired = repairTrivialCopy({
        title: removeUndeliverablePromises(listing.title, deliverable),
        tags: listing.tags.map((tag) => removeUndeliverablePromises(tag, deliverable)).filter(Boolean),
        description: cleanLines.join("\n"),
        priceChf: listing.priceChf,
        productType: listing.productType,
        deliverable,
      }, { product: { type: listing.productType, ...(productPreset ? { pod: productPreset } : {}) } });
      const draft = repaired.draft;
      const validated = validateListing(draft);
      const deliveryUrl = listing.productType === "digital" ? processed.url : listing.deliveryUrl;
      const fileManifest = listing.productType === "digital"
        ? await buildFileManifest(deliveryUrl!, listing.imageUrl)
        : listing.fileManifest;
      const gate = evaluateQualityGate({
        title: draft.title,
        tags: draft.tags,
        description: draft.description,
        priceChf: draft.priceChf,
        productType: listing.productType,
        podProvider: listing.podProvider,
        imageUrl: listing.imageUrl,
        artworkUrl: processed.url,
        printWidth: outputPx.width,
        printHeight: outputPx.height,
        colorVariance: measured.variance,
        printTargetKey: listingTargetKey,
        printTarget: listing.productType === "pod" ? listingTarget : undefined,
        upscaleMethod: processed.upscaleMethod,
      });
      const validation = [
        ...validated.issues,
        ...gate.reasons.filter((reason) => !validated.issues.some((item) => item.code === reason.code && item.message === reason.message)),
      ];
      if (validation.some((issue) => issue.code === "undeliverable_promise")) {
        report.push({ id, listingId: listing.id, skipped: "Copy still contains an undeliverable promise after repair." });
        continue;
      }
      listingUpdates.push({
        id: listing.id,
        title: draft.title,
        tags: draft.tags,
        description: draft.description,
        deliveryUrl,
        fileManifest,
        validation,
        status: gate.pass && validated.valid ? "pending_approval" : "quality_failed",
      });
    }

    if (apply) {
      await db.update(designs).set({
        imageUrl: processed.url,
        sourceImageUrl: design.sourceImageUrl ?? design.imageUrl,
        sourcePx: processed.sourcePx,
        outputPx,
        upscaleMethod: processed.upscaleMethod,
        printTarget: target,
        imageWidth: outputPx.width,
        imageHeight: outputPx.height,
        colorVariance: measured.variance,
      }).where(eq(designs.id, id));
      for (const updated of listingUpdates) {
        await db.update(listings).set({
          title: updated.title,
          tags: updated.tags,
          description: updated.description,
          deliveryUrl: updated.deliveryUrl,
          fileManifest: updated.fileManifest,
          fileVerifiedAt: null,
          fileVerifiedBy: null,
          validation: updated.validation,
          status: updated.status,
          updatedAt: new Date(),
        }).where(eq(listings.id, updated.id));
      }
    }
    report.push({
      id,
      mode: apply ? "applied" : "preview",
      upscaleMethod: processed.upscaleMethod,
      sourcePx: processed.sourcePx,
      outputPx,
      target,
      listings: listingUpdates.map(({ id: listingId, title, status }) => ({ id: listingId, title, status })),
    });
  }
  return report;
}

function parseArgs(args: string[]) {
  let ids: number[] | undefined;
  let apply = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--apply") {
      apply = true;
    } else if (args[index] === "--ids") {
      ids = (args[++index] ?? "").split(",").map((value) => Number(value.trim()));
    } else {
      throw new Error(`Unknown option: ${args[index]}`);
    }
  }
  if (!ids?.length || ids.some((id) => !Number.isInteger(id) || id < 1)) throw new Error("Usage: npm run designs:upscale -- --ids 118,119,120 [--apply]");
  return { ids, apply };
}

async function main() {
  const { ids, apply } = parseArgs(process.argv.slice(2));
  const report = await upscaleDesigns(await getDb(), ids, apply);
  console.log(JSON.stringify({ mode: apply ? "apply" : "preview", report }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Design upscaling failed.");
    process.exitCode = 1;
  });
}
