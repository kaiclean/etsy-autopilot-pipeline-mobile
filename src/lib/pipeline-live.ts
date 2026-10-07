import { and, desc, isNotNull } from "drizzle-orm";
import type { DB } from "@/db";
import { jobRuns, listings } from "@/db/schema";
import { visible } from "@/lib/events";

export type LiveLogLine = {
  t: string;
  level: "info" | "warn" | "error";
  stage: string;
  message: string;
  runId: number;
};

export type LiveRun = {
  id: number;
  stage: string;
  status: string;
  trigger: string;
  summary: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  errorCount: number;
};

export type LivePublishError = {
  id: number;
  title: string;
  publishError: string;
  updatedAt: string;
};

export type PipelineLive = {
  runs: LiveRun[];
  lines: LiveLogLine[];
  publishErrors: LivePublishError[];
};

export async function loadPipelineLive(db: DB, opts?: { errorsOnly?: boolean; limit?: number }): Promise<PipelineLive> {
  const limit = opts?.limit ?? 20;
  const rows = await db.select().from(jobRuns).where(visible(jobRuns.isDemo)).orderBy(desc(jobRuns.id)).limit(limit);
  const runs: LiveRun[] = rows.map((row) => {
    const started = row.startedAt?.getTime?.() ?? new Date(row.startedAt).getTime();
    const finished = row.finishedAt ? new Date(row.finishedAt).getTime() : null;
    const errorCount = (row.logs ?? []).filter((line) => line.level === "error").length;
    return {
      id: row.id,
      stage: row.stage,
      status: row.status,
      trigger: row.trigger,
      summary: row.summary,
      startedAt: new Date(row.startedAt).toISOString(),
      finishedAt: row.finishedAt ? new Date(row.finishedAt).toISOString() : null,
      durationMs: finished != null && Number.isFinite(started) ? Math.max(0, finished - started) : null,
      errorCount,
    };
  });
  const lines: LiveLogLine[] = [];
  for (const row of rows) {
    for (const line of row.logs ?? []) {
      if (opts?.errorsOnly && line.level !== "error") continue;
      lines.push({ t: line.t, level: line.level, stage: row.stage, message: line.msg, runId: row.id });
    }
  }
  const failed = await db
    .select({ id: listings.id, title: listings.title, publishError: listings.publishError, updatedAt: listings.updatedAt })
    .from(listings)
    .where(and(isNotNull(listings.publishError), visible(listings.isDemo)))
    .orderBy(desc(listings.updatedAt))
    .limit(12);
  return {
    runs: opts?.errorsOnly ? runs.filter((run) => run.status === "failed" || run.errorCount > 0) : runs,
    lines,
    publishErrors: failed.flatMap((row) =>
      row.publishError ? [{ id: row.id, title: row.title, publishError: row.publishError, updatedAt: new Date(row.updatedAt).toISOString() }] : [],
    ),
  };
}
