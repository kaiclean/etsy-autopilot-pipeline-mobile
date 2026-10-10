import { and, asc, count, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { cleanupFakeOrdersIfPresent, type ClearCounts } from "@/db/clear-fake-orders";
import type { DB } from "@/db";
import { listings } from "@/db/schema";
import { backfillInlineImages, IMAGE_BACKFILL_BATCH_LIMIT } from "@/lib/image-backfill";
import { manifestIsComplete, type ManifestLoadDeps } from "@/lib/file-manifest";
import { storageBackend } from "@/lib/config";
import { materializeImageUrl } from "@/lib/object-storage";
import { ensurePrintifyWebhooks } from "@/lib/printify-webhooks";
import { recordDeliveryManifest } from "./human-publish";
import type { StageFn } from "./types";

export type MaintenanceSummary = {
  webhooks: { existing: number; created: number; skipped: number; reason: string | null };
  images: { rewritten: number; remaining: number; reason: string | null };
  fakeRows: {
    orders: number;
    costs: number;
    daily_stats: number;
    job_runs: number;
    events: number;
    reason: string | null;
  };
  /** Digital rows whose delivery file was hashed this run, including older ids such as listing 46. */
  manifests: { recorded: number; remaining: number };
};

function emptyFakeRows(reason: string | null): MaintenanceSummary["fakeRows"] {
  return { orders: 0, costs: 0, daily_stats: 0, job_runs: 0, events: 0, reason };
}

function fakeRowsFrom(counts: ClearCounts): MaintenanceSummary["fakeRows"] {
  return {
    orders: counts.orders,
    costs: counts.costs,
    daily_stats: counts.dailyStats,
    job_runs: counts.jobRuns,
    events: counts.events,
    reason: null,
  };
}

function cleanupRefusal(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return message.includes("DEMO_MODE=true") || message.includes("demo mode is on");
}

async function rewriteInlineImages(db: DB): Promise<MaintenanceSummary["images"]> {
  if (storageBackend() !== "s3") {
    const report = await backfillInlineImages(
      db,
      async () => {
        throw new Error("S3 is not configured");
      },
      { dryRun: true },
    );
    return {
      rewritten: 0,
      remaining: report.listingCandidates + report.designCandidates,
      reason: "S3 is not configured",
    };
  }
  const report = await backfillInlineImages(
    db,
    async (dataUrl) => {
      const stored = await materializeImageUrl(dataUrl);
      if (!stored || stored.startsWith("data:")) throw new Error("Upload did not return a stored URL");
      return stored;
    },
    { limit: IMAGE_BACKFILL_BATCH_LIMIT },
  );
  return {
    rewritten: report.updatedListings + report.updatedDesigns,
    remaining: report.remaining,
    reason: null,
  };
}

/** Rows a maintenance run tries to hash. Complete manifests are excluded in SQL, so later ids are reached. */
export const MANIFEST_BACKFILL_BATCH_LIMIT = 200;

function incompleteDigitalManifest() {
  const delivery = sql`${listings.fileManifest}->'delivery'`;
  const notPositive = (field: "width" | "height" | "bytes") => {
    const key = sql.raw(`'${field}'`);
    return sql`not coalesce(case when jsonb_typeof(${delivery}->${key}) = 'number' then (${delivery}->>${key})::numeric > 0 end, false)`;
  };
  return and(
    eq(listings.productType, "digital"),
    isNotNull(listings.deliveryUrl),
    or(
      isNull(listings.fileManifest),
      sql`coalesce(${delivery}->>'filename', '') = ''`,
      sql`coalesce(${delivery}->>'sha256', '') !~ '^[a-f0-9]{64}$'`,
      notPositive("width"),
      notPositive("height"),
      notPositive("bytes"),
    ),
  );
}

/**
 * Hashes digital delivery files that are still missing a manifest, oldest id first so listing 46 is in the first batch.
 * An unreadable file is left for the next run and never fails maintenance.
 */
export async function backfillDigitalManifests(db: DB, deps: ManifestLoadDeps = {}): Promise<MaintenanceSummary["manifests"]> {
  const rows = await db
    .select({ id: listings.id, fileManifest: listings.fileManifest })
    .from(listings)
    .where(incompleteDigitalManifest())
    .orderBy(asc(listings.id))
    .limit(MANIFEST_BACKFILL_BATCH_LIMIT);
  let recorded = 0;
  for (const row of rows) {
    if (manifestIsComplete(row.fileManifest)) continue;
    try {
      const result = await recordDeliveryManifest(db, row.id, new Date(), deps);
      if (result.ok) recorded++;
    } catch {
      /* Counted in `remaining` below; the next run retries. */
    }
  }
  const [left] = await db.select({ n: count() }).from(listings).where(incompleteDigitalManifest());
  return { recorded, remaining: Number(left?.n ?? 0) };
}

async function removeFakeRows(db: DB): Promise<MaintenanceSummary["fakeRows"]> {
  try {
    return fakeRowsFrom(await cleanupFakeOrdersIfPresent(db));
  } catch (error) {
    if (cleanupRefusal(error)) {
      const message = error instanceof Error ? error.message : "cleanup refused";
      return emptyFakeRows(message);
    }
    throw error;
  }
}

/** Idempotent housekeeping. Counts only; skip reasons name the gate, never a secret. */
export async function runMaintenanceTasks(db: DB, log: (msg: string) => void = () => {}, deps: ManifestLoadDeps = {}): Promise<MaintenanceSummary> {
  const webhooks = await ensurePrintifyWebhooks();
  log(
    webhooks.reason
      ? `Printify webhooks skipped: ${webhooks.reason}`
      : `Printify webhooks existing=${webhooks.existing} created=${webhooks.created}`,
  );
  const images = await rewriteInlineImages(db);
  log(
    images.reason
      ? `Image backfill skipped: ${images.reason}`
      : `Image backfill rewritten=${images.rewritten} remaining=${images.remaining}`,
  );
  const fakeRows = await removeFakeRows(db);
  log(
    fakeRows.reason
      ? `Fake-order cleanup skipped: ${fakeRows.reason}`
      : `Fake-order cleanup orders=${fakeRows.orders} costs=${fakeRows.costs} daily_stats=${fakeRows.daily_stats} job_runs=${fakeRows.job_runs} events=${fakeRows.events}`,
  );
  const manifests = await backfillDigitalManifests(db, deps);
  log(`Digital file manifests recorded=${manifests.recorded} remaining=${manifests.remaining}`);
  return { webhooks, images, fakeRows, manifests };
}

export function parseMaintenanceSummary(summary: string | null): MaintenanceSummary | string | null {
  if (!summary) return summary;
  try {
    const parsed = JSON.parse(summary) as MaintenanceSummary;
    if (parsed && typeof parsed === "object" && parsed.webhooks && parsed.images && parsed.fakeRows) {
      return { ...parsed, manifests: parsed.manifests ?? { recorded: 0, remaining: 0 } };
    }
  } catch {
    /* Older rows store a sentence. */
  }
  return summary;
}

export const runMaintenance: StageFn = async (ctx) => {
  const summary = await runMaintenanceTasks(ctx.db, ctx.log);
  return JSON.stringify(summary);
};
