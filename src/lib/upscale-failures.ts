import { and, eq, isNull, sql } from "drizzle-orm";
import type { DB } from "@/db";
import { designs, upscaleUploads } from "@/db/schema";

export const MAX_UPSCALE_ATTEMPTS = 3;

/** Worker-reported failure; on the 3rd the design is marked failed and leaves the job list (no re-upscale loop). */
export async function recordUpscaleFailure(db: DB, designId: number, error: string, reportId?:string) {
  const result = await db.execute<{failure: NonNullable<typeof designs.$inferSelect.upscaleFailure>}>(sql`
    with accepted as (
      insert into upscale_failure_reports (report_id,design_id) select ${reportId??null},${designId} where ${reportId??null}::text is not null
      on conflict do nothing returning report_id
    )
    update designs set upscale_failure = jsonb_build_object(
      'attempts', coalesce((upscale_failure->>'attempts')::integer,0) + 1,
      'failed', coalesce((upscale_failure->>'attempts')::integer,0) + 1 >= ${MAX_UPSCALE_ATTEMPTS},
      'lastError', ${error.slice(0,300)}::text, 'at', now()) where id=${designId} and (${reportId??null}::text is null or exists(select 1 from accepted)) returning upscale_failure as failure
  `);
  return result.rows[0]?.failure ?? (await db.select({failure:designs.upscaleFailure}).from(designs).where(eq(designs.id,designId)))[0]?.failure ?? null;
}

export async function bindUploadKey(db: DB, key: string, designId: number) {
  const [design]=await db.select().from(designs).where(eq(designs.id,designId));
  if(!design) throw new Error("Design missing");
  await db.insert(upscaleUploads).values({ key, designId,sourceUrl:design.imageUrl });
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
