import { BrainPage as Shell, Empty } from "@/components/brain/shell";
import { getDb } from "@/db";
import { readPublishMode, liveWritesEnabled } from "@/lib/read-publish-mode";
import { SESSION_STAGES, TASK_STATUSES, isActive, listSessions, listTasks } from "@/lib/brain/sessions";
import { cancelSessionAction, createTaskAction, deleteTaskAction, retrySessionAction, startSessionAction, updateTaskAction } from "./actions";
import { SessionPoller } from "./poller";
export const dynamic = "force-dynamic";

const PILL: Record<string, string> = { success: "ok", warning: "res", failed: "bad", running: "res", queued: "", skipped: "", cancelled: "" };
const LABEL = Object.fromEntries(SESSION_STAGES.map((s) => [s.id, s.label])) as Record<string, string>;
const fmt = (d: Date | null) => (d ? new Date(d).toLocaleString("de-CH", { timeZone: "Europe/Zurich", dateStyle: "short", timeStyle: "medium" }) : "–");

export default async function Sessions({ searchParams }: { searchParams: Promise<{ ok?: string; err?: string }> }) {
  const { ok, err } = await searchParams;
  const db = await getDb();
  const [sessions, tasks, mode, live] = await Promise.all([listSessions(db), listTasks(db), readPublishMode(db), liveWritesEnabled(db)]);
  const active = sessions.some(isActive);
  return (
    <Shell>
      {err && <div className="notice" role="alert">{err}</div>}
      {ok && <div className="notice ok" role="status">✓ {ok}</div>}
      <div className="page-head"><div><h2>Sessions</h2>
        <p>Start a pipeline stage, watch its log, cancel or retry. Publish mode: <b>{mode}</b>{live ? " (live writes on, so publish sessions are blocked)" : " (dry-run)"}. Sessions never activate listings, change ads, or switch publish mode.</p></div>
        <SessionPoller active={active} /></div>

      <form action={startSessionAction} className="card sess-start">
        <label>Stage<select name="stage" defaultValue="daily">{SESSION_STAGES.map((s) => <option key={s.id} value={s.id} disabled={s.id === "publish" && live}>{s.label}</option>)}</select></label>
        <button className="btn-primary" type="submit">Start session</button>
      </form>

      <h3 className="sess-h">Recent sessions</h3>
      {!sessions.length && <Empty icon="▶" title="No sessions yet">Start one above.</Empty>}
      <div className="sess-list">
        {sessions.map((s) => (
          <details key={s.id} className="card sess" open={isActive(s)}>
            <summary>
              <div className="row between"><b>#{s.id} · {LABEL[s.stage] ?? s.stage}</b><span className={"pill " + (PILL[s.status] ?? "")}>{s.cancelRequested && s.status === "running" ? "cancelling" : s.status}</span></div>
              <div className="xs muted">{fmt(s.createdAt)}{s.retryOf ? ` · retry of #${s.retryOf}` : ""}{s.taskId ? ` · task #${s.taskId}` : ""}</div>
              {s.summary && <div className="xs" style={{ marginTop: 4 }}>{s.summary}</div>}
            </summary>
            <pre className="sess-log" aria-label="Session log">{s.logs.length ? s.logs.map((l) => `${l.level === "error" ? "✗" : l.level === "warn" ? "!" : "·"} ${l.msg}`).join("\n") : isActive(s) ? "Waiting for log lines…" : "No log lines."}</pre>
            <div className="sess-actions">
              {isActive(s) && <form action={cancelSessionAction}><input type="hidden" name="id" value={s.id} /><button type="submit" className="btn-ghost">Cancel</button></form>}
              {!isActive(s) && <form action={retrySessionAction}><input type="hidden" name="id" value={s.id} /><button type="submit" className="btn-ghost">Retry</button></form>}
            </div>
          </details>
        ))}
      </div>

      <h3 className="sess-h">Tasks</h3>
      <form action={createTaskAction} className="card sess-task-new">
        <label>Task<input name="title" required maxLength={200} placeholder="e.g. Refresh alpine keywords" /></label>
        <label>Stage<select name="stage" defaultValue="research">{SESSION_STAGES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label>
        <label>Notes<input name="notes" maxLength={2000} /></label>
        <button className="btn-primary" type="submit">Add task</button>
      </form>
      {!tasks.length && <Empty icon="✓" title="No tasks">Add one above and assign it to a stage.</Empty>}
      <div className="sess-list">
        {tasks.map((t) => (
          <div key={t.id} className="card sess-task">
            <div className="row between"><b className={t.status === "done" ? "muted" : ""}>{t.title}</b><span className={"pill " + (t.status === "done" ? "ok" : t.status === "doing" ? "res" : "")}>{t.status}</span></div>
            <div className="xs muted">{LABEL[t.stage] ?? t.stage}{t.lastSessionId ? ` · last session #${t.lastSessionId}` : ""}{t.notes ? ` · ${t.notes}` : ""}</div>
            <div className="sess-actions">
              <form action={updateTaskAction}><input type="hidden" name="id" value={t.id} />
                <select name="status" defaultValue={t.status} aria-label="Status">{TASK_STATUSES.map((x) => <option key={x} value={x}>{x}</option>)}</select>
                <select name="stage" defaultValue={t.stage} aria-label="Assign stage">{SESSION_STAGES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select>
                <button type="submit" className="btn-ghost">Save</button></form>
              {t.status !== "done" && <form action={startSessionAction}><input type="hidden" name="stage" value={t.stage} /><input type="hidden" name="taskId" value={t.id} /><button type="submit" className="btn-primary">Run stage</button></form>}
              <form action={deleteTaskAction}><input type="hidden" name="id" value={t.id} /><button type="submit" className="btn-ghost">Delete</button></form>
            </div>
          </div>
        ))}
      </div>
    </Shell>
  );
}
