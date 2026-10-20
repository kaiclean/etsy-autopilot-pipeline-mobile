import { and, desc, eq, gte } from "drizzle-orm";
import type { DB } from "@/db";
import { brainSessions, brainTasks, jobRuns, type StageName } from "@/db/schema";
import { liveWritesEnabled } from "@/lib/read-publish-mode";

/**
 * Stages a dashboard session may start. Publish runs only while writes are in dry-run;
 * nothing here activates listings, changes ads, or touches PUBLISH_MODE.
 */
export const SESSION_STAGES = [
  { id: "research", label: "Research" },
  { id: "design", label: "Design" },
  { id: "listing", label: "Listing" },
  { id: "publish", label: "Publish (dry-run only)" },
  { id: "orders", label: "Orders" },
  { id: "analytics", label: "Analytics" },
  { id: "health", label: "Health" },
  { id: "daily", label: "Full daily chain" },
] as const satisfies readonly { id: StageName; label: string }[];

export type SessionStage = (typeof SESSION_STAGES)[number]["id"];
export const TASK_STATUSES = ["todo", "doing", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type Session = typeof brainSessions.$inferSelect;
export type Task = typeof brainTasks.$inferSelect;
export type Runner = (stage: StageName) => Promise<{ id: number; status: string; summary: string | null }>;

export const isSessionStage = (s: unknown): s is SessionStage => SESSION_STAGES.some((x) => x.id === s);
const ACTIVE = new Set(["queued", "running"]);
export const isActive = (s: Pick<Session, "status">) => ACTIVE.has(s.status);

/** Returns a reason when the stage must not run from the dashboard right now. */
export async function sessionBlocker(db: DB, stage: string): Promise<string | null> {
  if (!isSessionStage(stage)) return "This stage can't be started from a session";
  if (stage === "publish" && (await liveWritesEnabled(db))) {
    return "Publish sessions run in dry-run only. Live writes are on, so this is blocked.";
  }
  const running = await db.select({ id: brainSessions.id }).from(brainSessions)
    .where(and(eq(brainSessions.stage, stage), eq(brainSessions.status, "running"))).limit(1);
  if (running.length) return `A ${stage} session is already running (#${running[0].id})`;
  return null;
}

/** Inserts a queued session, or returns the reason it was refused. */
export async function createSession(db: DB, stage: string, opts: { retryOf?: number; taskId?: number } = {}) {
  const blocker = await sessionBlocker(db, stage);
  if (blocker) return { ok: false as const, error: blocker };
  const [row] = await db.insert(brainSessions)
    .values({ stage: stage as SessionStage, retryOf: opts.retryOf ?? null, taskId: opts.taskId ?? null }).returning();
  if (opts.taskId) {
    await db.update(brainTasks).set({ status: "doing", lastSessionId: row.id, updatedAt: new Date() }).where(eq(brainTasks.id, opts.taskId));
  }
  return { ok: true as const, session: row };
}

/** Runs a queued session to completion. Safe to call from `after()`. */
export async function executeSession(db: DB, id: number, run: Runner): Promise<Session | null> {
  const [s] = await db.select().from(brainSessions).where(eq(brainSessions.id, id));
  if (!s || s.status !== "queued") return s ?? null;
  if (s.cancelRequested) return finish(db, id, "cancelled", "Cancelled before it started");
  // Re-check the publish guard at run time: the mode may have changed since queueing.
  if (s.stage === "publish" && (await liveWritesEnabled(db))) return finish(db, id, "failed", "Blocked: publish sessions run in dry-run only");
  await db.update(brainSessions).set({ status: "running", startedAt: new Date() }).where(eq(brainSessions.id, id));
  try {
    const result = await run(s.stage);
    const [now] = await db.select().from(brainSessions).where(eq(brainSessions.id, id));
    const status = now?.cancelRequested ? "cancelled" : (["success", "warning", "failed", "skipped"].includes(result.status) ? result.status : "failed");
    const summary = now?.cancelRequested ? `Cancelled. Stage result: ${result.summary ?? result.status}` : result.summary;
    await db.update(brainSessions).set({ jobRunId: result.id }).where(eq(brainSessions.id, id));
    return finish(db, id, status as Session["status"], summary);
  } catch (error) {
    return finish(db, id, "failed", error instanceof Error ? error.message : "Session failed");
  }
}

async function finish(db: DB, id: number, status: Session["status"], summary: string | null) {
  const [row] = await db.update(brainSessions).set({ status, summary, finishedAt: new Date() }).where(eq(brainSessions.id, id)).returning();
  if (row?.taskId && status !== "cancelled") {
    await db.update(brainTasks).set({ updatedAt: new Date() }).where(eq(brainTasks.id, row.taskId));
  }
  return row ?? null;
}

/** Queued sessions cancel at once; a running stage finishes its current step and is then marked cancelled. */
export async function cancelSession(db: DB, id: number) {
  const [s] = await db.select().from(brainSessions).where(eq(brainSessions.id, id));
  if (!s) return { ok: false as const, error: "Session not found" };
  if (!isActive(s)) return { ok: false as const, error: `Session already ${s.status}` };
  if (s.status === "queued") { await finish(db, id, "cancelled", "Cancelled before it started"); return { ok: true as const }; }
  await db.update(brainSessions).set({ cancelRequested: true }).where(eq(brainSessions.id, id));
  return { ok: true as const };
}

export async function retrySession(db: DB, id: number) {
  const [s] = await db.select().from(brainSessions).where(eq(brainSessions.id, id));
  if (!s) return { ok: false as const, error: "Session not found" };
  if (isActive(s)) return { ok: false as const, error: "Session is still active" };
  return createSession(db, s.stage, { retryOf: s.id, taskId: s.taskId ?? undefined });
}

/** A running session's log comes from the newest job run of its stage since it started. */
export async function sessionLogs(db: DB, s: Session) {
  const where = s.jobRunId
    ? eq(jobRuns.id, s.jobRunId)
    : s.startedAt ? and(eq(jobRuns.stage, s.stage), gte(jobRuns.startedAt, s.startedAt)) : null;
  if (!where) return [];
  const [run] = await db.select({ logs: jobRuns.logs }).from(jobRuns).where(where).orderBy(desc(jobRuns.id)).limit(1);
  return (run?.logs ?? []).slice(-200);
}

export async function listSessions(db: DB, limit = 20) {
  const rows = await db.select().from(brainSessions).orderBy(desc(brainSessions.id)).limit(limit);
  return Promise.all(rows.map(async (s) => ({ ...s, logs: await sessionLogs(db, s) })));
}

export function cleanTask(input: { title?: unknown; notes?: unknown; stage?: unknown }) {
  const title = String(input.title ?? "").trim().slice(0, 200);
  if (!title) return { ok: false as const, error: "Title is required" };
  const stage = isSessionStage(input.stage) ? input.stage : null;
  if (!stage) return { ok: false as const, error: "Pick a stage" };
  const notes = String(input.notes ?? "").trim().slice(0, 2000) || null;
  return { ok: true as const, value: { title, notes, stage } };
}

export async function createTask(db: DB, input: { title?: unknown; notes?: unknown; stage?: unknown }) {
  const c = cleanTask(input);
  if (!c.ok) return c;
  const [task] = await db.insert(brainTasks).values(c.value).returning();
  return { ok: true as const, task };
}

export async function updateTask(db: DB, id: number, patch: { status?: unknown; stage?: unknown }) {
  const set: Partial<Task> = { updatedAt: new Date() };
  if (patch.status !== undefined) {
    if (!TASK_STATUSES.includes(patch.status as TaskStatus)) return { ok: false as const, error: "Bad status" };
    set.status = patch.status as TaskStatus;
  }
  if (patch.stage !== undefined) {
    if (!isSessionStage(patch.stage)) return { ok: false as const, error: "Bad stage" };
    set.stage = patch.stage;
  }
  const [task] = await db.update(brainTasks).set(set).where(eq(brainTasks.id, id)).returning();
  return task ? { ok: true as const, task } : { ok: false as const, error: "Task not found" };
}

export async function deleteTask(db: DB, id: number) {
  await db.delete(brainTasks).where(eq(brainTasks.id, id));
  return { ok: true as const };
}

export const listTasks = (db: DB) => db.select().from(brainTasks).orderBy(brainTasks.status, desc(brainTasks.updatedAt)).limit(100);
