import { desc } from "drizzle-orm";
import { getDb } from "@/db";
import { jobRuns, type JobRun, type StageName } from "@/db/schema";
import { STAGES } from "@/pipeline/types";
import { visible } from "./events";

export async function getLastRuns() {
  const db = await getDb();
  const runs = await db.select().from(jobRuns).where(visible(jobRuns.isDemo)).orderBy(desc(jobRuns.id)).limit(200);
  const last: Partial<Record<StageName, JobRun>> = {};
  for (const r of runs) if (!last[r.stage]) last[r.stage] = r;
  return STAGES.map((s) => ({ ...s, run: last[s.id] ?? null }));
}
