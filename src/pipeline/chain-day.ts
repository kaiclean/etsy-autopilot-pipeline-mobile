import { and, eq, gte } from "drizzle-orm";
import type { DB } from "@/db";
import { jobRuns, type StageName } from "@/db/schema";
import { utcDayStart } from "@/lib/utc-day";

/** True when this shop already recorded a successful run of `stage` on the UTC day of `now`. */
export async function stageSucceededToday(db: DB, shopId: string, stage: StageName, now: Date) {
  const [row] = await db
    .select({ id: jobRuns.id })
    .from(jobRuns)
    .where(and(eq(jobRuns.shopId, shopId), eq(jobRuns.stage, stage), eq(jobRuns.status, "success"), gte(jobRuns.startedAt, utcDayStart(now))))
    .limit(1);
  return Boolean(row);
}
