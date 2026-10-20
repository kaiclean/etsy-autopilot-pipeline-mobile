import path from "node:path";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { setSetting, getSetting } from "@/lib/settings";
import {
  SESSION_STAGES, cancelSession, createSession, createTask, executeSession, listSessions, listTasks, retrySession, sessionBlocker, updateTask,
} from "@/lib/brain/sessions";

let client: PGlite | null = null;
async function freshDb() {
  client = new PGlite("memory://");
  const db = drizzle(client, { schema }) as DB;
  await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  return db;
}
afterEach(async () => { await client?.close(); client = null; });
const ok = (status = "success") => async () => ({ id: 0, status, summary: `ran ${status}` });

describe("brain sessions", () => {
  it("migration 0026 is idempotent", async () => {
    await freshDb();
    const sql = readFileSync(path.join(process.cwd(), "drizzle/0026_brain_sessions.sql"), "utf8");
    for (const stmt of sql.split("--> statement-breakpoint")) if (stmt.trim()) await client!.exec(stmt);
  });

  it("offers only safe stages", () => {
    const ids = SESSION_STAGES.map((s) => s.id);
    expect(ids).toEqual(["research", "design", "listing", "publish", "orders", "analytics", "health", "daily"]);
  });

  it("refuses unknown stages", async () => {
    const db = await freshDb();
    expect(await sessionBlocker(db, "maintenance")).toMatch(/can't be started/);
    expect((await createSession(db, "activate")).ok).toBe(false);
  });

  it("blocks publish when live writes are on", async () => {
    const db = await freshDb();
    const prev = process.env.PUBLISH_MODE;
    process.env.PUBLISH_MODE = "live";
    try {
      const { config } = await import("@/lib/config");
      const hostMode = config.publishMode;
      await setSetting(db, "automation", { ...(await getSetting(db, "automation")), publishMode: "live" });
      const blocker = await sessionBlocker(db, "publish");
      // Host dry-run in tests keeps writes off; either way publish never runs live.
      if (hostMode === "live") expect(blocker).toMatch(/dry-run only/);
      else expect(blocker).toBeNull();
    } finally { process.env.PUBLISH_MODE = prev; }
  });

  it("runs, records status and frees the stage", async () => {
    const db = await freshDb();
    const res = await createSession(db, "research");
    if (!res.ok) throw new Error(res.error);
    const seen: string[] = [];
    const done = await executeSession(db, res.session.id, async (s) => { seen.push(s); return { id: 0, status: "warning", summary: "2 keywords" }; });
    expect(seen).toEqual(["research"]);
    expect(done).toMatchObject({ status: "warning", summary: "2 keywords" });
    expect(done?.finishedAt).toBeTruthy();
    // A finished session doesn't run twice.
    expect((await executeSession(db, res.session.id, async () => { throw new Error("no"); }))?.status).toBe("warning");
  });

  it("records thrown errors as failed", async () => {
    const db = await freshDb();
    const res = await createSession(db, "design");
    if (!res.ok) throw new Error(res.error);
    const s = await executeSession(db, res.session.id, async () => { throw new Error("boom"); });
    expect(s).toMatchObject({ status: "failed", summary: "boom" });
  });

  it("refuses a second running session of the same stage", async () => {
    const db = await freshDb();
    const a = await createSession(db, "listing");
    if (!a.ok) throw new Error(a.error);
    let release!: () => void;
    const p = executeSession(db, a.session.id, () => new Promise((r) => { release = () => r({ id: 0, status: "success", summary: "ok" }); }));
    await new Promise((r) => setTimeout(r, 50));
    expect((await createSession(db, "listing")).ok).toBe(false);
    release(); await p;
    expect((await createSession(db, "listing")).ok).toBe(true);
  });

  it("cancels queued sessions at once and running ones after the step", async () => {
    const db = await freshDb();
    const q = await createSession(db, "orders");
    if (!q.ok) throw new Error(q.error);
    expect((await cancelSession(db, q.session.id)).ok).toBe(true);
    expect((await executeSession(db, q.session.id, ok()))?.status).toBe("cancelled");

    const r = await createSession(db, "analytics");
    if (!r.ok) throw new Error(r.error);
    const s = await executeSession(db, r.session.id, async () => { await cancelSession(db, r.session.id); return { id: 0, status: "success", summary: "done" }; });
    expect(s?.status).toBe("cancelled");
    expect((await cancelSession(db, r.session.id)).ok).toBe(false);
  });

  it("cancel stops a running stage instead of waiting for it", async () => {
    const db = await freshDb();
    const r = await createSession(db, "analytics");
    if (!r.ok) throw new Error(r.error);
    let aborted = false;
    // A stage that would run for a minute unless it is aborted.
    const started = Date.now();
    const p = executeSession(db, r.session.id, (_stage, signal) => new Promise((resolve) => {
      signal.addEventListener("abort", () => { aborted = true; });
      setTimeout(() => resolve({ id: 0, status: "success", summary: "too late" }), 60_000);
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await cancelSession(db, r.session.id)).ok).toBe(true);
    const s = await p;
    expect(s?.status).toBe("cancelled");
    expect(aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 15_000);

  it("retries a finished session as a new linked one", async () => {
    const db = await freshDb();
    const a = await createSession(db, "health");
    if (!a.ok) throw new Error(a.error);
    expect((await retrySession(db, a.session.id)).ok).toBe(false); // still queued
    await executeSession(db, a.session.id, ok("failed"));
    const b = await retrySession(db, a.session.id);
    expect(b.ok && b.session.retryOf).toBe(a.session.id);
    expect((await listSessions(db)).map((s) => s.id)).toEqual([b.ok ? b.session.id : 0, a.session.id]);
  });

  it("logs come from the stage's job run", async () => {
    const db = await freshDb();
    const a = await createSession(db, "research");
    if (!a.ok) throw new Error(a.error);
    await executeSession(db, a.session.id, async (stage) => {
      const [run] = await db.insert(schema.jobRuns).values({ stage, status: "success", trigger: "manual", summary: "ok", logs: [{ t: new Date().toISOString(), level: "info", msg: "hello" }] as never }).returning();
      return run;
    });
    const [s] = await listSessions(db);
    expect(s.logs.map((l) => l.msg)).toEqual(["hello"]);
  });

  it("creates, assigns and tracks tasks", async () => {
    const db = await freshDb();
    expect((await createTask(db, { title: " ", stage: "research" })).ok).toBe(false);
    expect((await createTask(db, { title: "x", stage: "activate" })).ok).toBe(false);
    const t = await createTask(db, { title: "Refresh alpine keywords", stage: "research" });
    if (!t.ok) throw new Error(t.error);
    expect((await updateTask(db, t.task.id, { stage: "design" })).ok).toBe(true);
    const s = await createSession(db, "design", { taskId: t.task.id });
    expect(s.ok).toBe(true);
    let [row] = await listTasks(db);
    expect(row).toMatchObject({ stage: "design", status: "doing", lastSessionId: s.ok ? s.session.id : -1 });
    expect((await updateTask(db, t.task.id, { status: "nope" })).ok).toBe(false);
    await updateTask(db, t.task.id, { status: "done" });
    [row] = await listTasks(db);
    expect(row.status).toBe("done");
  });
});
