import { and, eq, isNull, sql } from "drizzle-orm";
import type { DB } from "@/db";
import { designs, upscaleUploads } from "@/db/schema";

export const MAX_UPSCALE_ATTEMPTS = 3;

/** Worker-reported failure; on the 3rd the design is marked failed and leaves the job list (no re-upscale loop). */
export async function recordUpscaleFailure(db: DB, designId: number, error: string) {
  const [row] = await db.select({ f: designs.upscaleFailure }).from(designs).where(eq(designs.id, designId));
  if (!row) return null;
  const attempts = (row.f?.attempts ?? 0) + 1;
  const failure = { attempts, lastError: error.slice(0, 300), at: new Date().toISOString(), failed: attempts >= MAX_UPSCALE_ATTEMPTS };
  await db.update(designs).set({ upscaleFailure: failure }).where(eq(designs.id, designId));
  console.log(`[upscale-jobs] design #${designId} upload failure ${attempts}/${MAX_UPSCALE_ATTEMPTS}${failure.failed ? " — marked FAILED" : ""}: ${failure.lastError}`);
  return failure;
}

export async function bindUploadKey(db: DB, key: string, designId: number) {
  await db.insert(upscaleUploads).values({ key, designId });
}

/** True only for an unconsumed key issued for this design; consumes it atomically. */
export async function consumeUploadKey(db: DB, key: string, designId: number) {
  const rows = await db.update(upscaleUploads).set({ consumedAt: new Date() })
    .where(and(eq(upscaleUploads.key, key), eq(upscaleUploads.designId, designId), isNull(upscaleUploads.consumedAt)))
    .returning({ key: upscaleUploads.key });
  return rows.length > 0;
}

/** Designs whose box upscale was marked failed after 3 reports (shown on /pipeline). */
export async function failedUpscaleJobs(dbArg?: DB) {
  const db = dbArg ?? await (await import("@/db")).getDb();
  const rows = await db.select({ id: designs.id, failure: designs.upscaleFailure }).from(designs)
    .where(sql`(${designs.upscaleFailure}->>'failed')::boolean is true`);
  return rows.filter((row): row is { id: number; failure: NonNullable<typeof row.failure> } => Boolean(row.failure));
}
