import { createHash } from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";
import type { DB } from "@/db";
import { designs, listings } from "@/db/schema";
import { applyStoredImageUrls, extractInlineDataUrl, inlineImagePredicate } from "@/lib/compact-image-url";

const READ_CHUNK = 500_000;

export type ImageBackfillReport = {
  dryRun: boolean;
  listingCandidates: number;
  designCandidates: number;
  listingBytes: number;
  designBytes: number;
  uploaded: number;
  updatedListings: number;
  updatedDesigns: number;
  skipped: number;
  failed: number;
  /** Inline rows still stored after this call, including rows past the batch limit. */
  remaining: number;
  errors: string[];
};

/** Rows a cron request rewrites. The CLI omits the limit and processes every row. */
export const IMAGE_BACKFILL_BATCH_LIMIT = 10;

type Upload = (dataUrl: string) => Promise<string>;

function asNumber(value: unknown) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Read one text cell in chunks so a single base64 image cannot exceed Neon’s 64 MiB response cap. */
export async function readTextColumn(
  db: DB,
  table: typeof listings | typeof designs,
  column: AnyColumn,
  id: number,
  chunkSize = READ_CHUNK,
): Promise<string | null> {
  const [meta] = await db
    .select({ n: sql<number | null>`char_length(${column})::int` })
    .from(table)
    .where(eq(table.id, id));
  if (meta?.n == null) return null;
  const length = asNumber(meta.n);
  if (length === 0) return "";
  let out = "";
  for (let offset = 1; offset <= length; offset += chunkSize) {
    const [part] = await db
      .select({ chunk: sql<string | null>`substr(${column}, ${offset}, ${chunkSize})` })
      .from(table)
      .where(eq(table.id, id));
    out += part?.chunk ?? "";
  }
  return out;
}

async function countInline(db: DB, table: typeof listings | typeof designs, column: AnyColumn) {
  const [row] = await db
    .select({
      n: sql<number>`count(*)::int`,
      bytes: sql<number>`coalesce(sum(octet_length(${column})), 0)::bigint`,
    })
    .from(table)
    .where(inlineImagePredicate(column));
  return { n: asNumber(row?.n), bytes: asNumber(row?.bytes) };
}

/**
 * Upload inline `image_url` / `delivery_url` values through the caller’s storage
 * function and replace them with the stored URL. Rows are read one at a time.
 */
export async function backfillInlineImages(
  db: DB,
  uploadDataUrl: Upload,
  opts: { dryRun?: boolean; limit?: number } = {},
): Promise<ImageBackfillReport> {
  const dryRun = Boolean(opts.dryRun);
  const [listingImages, listingDelivery, designImages] = await Promise.all([
    countInline(db, listings, listings.imageUrl),
    countInline(db, listings, listings.deliveryUrl),
    countInline(db, designs, designs.imageUrl),
  ]);
  const listingIds = await db
    .select({ id: listings.id })
    .from(listings)
    .where(sql`${inlineImagePredicate(listings.imageUrl)} OR ${inlineImagePredicate(listings.deliveryUrl)}`)
    .orderBy(asc(listings.id));
  const designIds = await db
    .select({ id: designs.id })
    .from(designs)
    .where(inlineImagePredicate(designs.imageUrl))
    .orderBy(asc(designs.id));

  const report: ImageBackfillReport = {
    dryRun,
    listingCandidates: listingIds.length,
    designCandidates: designIds.length,
    listingBytes: listingImages.bytes + listingDelivery.bytes,
    designBytes: designImages.bytes,
    uploaded: 0,
    updatedListings: 0,
    updatedDesigns: 0,
    skipped: 0,
    failed: 0,
    remaining: listingIds.length + designIds.length,
    errors: [],
  };
  if (dryRun) return report;

  const budget = opts.limit == null || !Number.isFinite(opts.limit) ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(opts.limit));
  const listingBatch = listingIds.slice(0, budget);
  const designBatch = designIds.slice(0, Math.max(0, budget - listingBatch.length));

  const cache = new Map<string, string>();
  const store = async (dataUrl: string) => {
    const hash = createHash("sha256").update(dataUrl).digest("hex");
    const hit = cache.get(hash);
    if (hit) return hit;
    const stored = await uploadDataUrl(dataUrl);
    if (!stored || extractInlineDataUrl(stored) || stored.startsWith("data:")) {
      throw new Error("Upload did not return a stored URL");
    }
    cache.set(hash, stored);
    report.uploaded += 1;
    return stored;
  };

  for (const { id } of listingBatch) {
    try {
      const imageUrl = (await readTextColumn(db, listings, listings.imageUrl, id)) ?? "";
      const deliveryUrl = await readTextColumn(db, listings, listings.deliveryUrl, id);
      const [meta] = await db.select({ niche: listings.niche }).from(listings).where(eq(listings.id, id));
      const dataUrls = [
        ...new Set(
          [extractInlineDataUrl(imageUrl), deliveryUrl ? extractInlineDataUrl(deliveryUrl) : null].filter(
            (value): value is string => Boolean(value),
          ),
        ),
      ];
      if (dataUrls.length === 0) {
        report.skipped += 1;
        continue;
      }
      const storedByDataUrl = new Map<string, string>();
      for (const dataUrl of dataUrls) storedByDataUrl.set(dataUrl, await store(dataUrl));
      const next = applyStoredImageUrls({
        imageUrl,
        deliveryUrl,
        niche: meta?.niche ?? null,
        storedByDataUrl,
      });
      if (next.imageUrl === imageUrl && next.deliveryUrl === deliveryUrl) {
        report.skipped += 1;
        continue;
      }
      await db
        .update(listings)
        .set({ imageUrl: next.imageUrl, deliveryUrl: next.deliveryUrl, updatedAt: new Date() })
        .where(eq(listings.id, id));
      report.updatedListings += 1;
    } catch (error) {
      report.failed += 1;
      report.errors.push(`listings #${id}: ${error instanceof Error ? error.message : "upload failed"}`);
    }
  }

  for (const { id } of designBatch) {
    try {
      const imageUrl = (await readTextColumn(db, designs, designs.imageUrl, id)) ?? "";
      const dataUrl = extractInlineDataUrl(imageUrl);
      if (!dataUrl) {
        report.skipped += 1;
        continue;
      }
      const stored = await store(dataUrl);
      if (stored === imageUrl) {
        report.skipped += 1;
        continue;
      }
      await db.update(designs).set({ imageUrl: stored }).where(eq(designs.id, id));
      report.updatedDesigns += 1;
    } catch (error) {
      report.failed += 1;
      report.errors.push(`designs #${id}: ${error instanceof Error ? error.message : "upload failed"}`);
    }
  }

  report.remaining = listingIds.length + designIds.length - report.updatedListings - report.updatedDesigns;
  return report;
}
