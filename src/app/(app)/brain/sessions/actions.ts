"use server";
import { after } from "next/server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import { config } from "@/lib/config";
import { getDb } from "@/db";
import { runStage } from "@/pipeline/runner";
import { writeStageLog } from "@/pipeline/stage-log";
import { cancelSession, createSession, createTask, deleteTask, executeSession, retrySession, updateTask } from "@/lib/brain/sessions";

const PAGE = "/brain/sessions";
async function guard() {
  if (!(await verifySessionToken((await cookies()).get(SESSION_COOKIE)?.value, config.authSecret))) redirect(`/login?next=${PAGE}`);
}
const done = (msg: string, ok = true): never => {
  revalidatePath(PAGE);
  redirect(`${PAGE}?${ok ? "ok" : "err"}=${encodeURIComponent(msg)}`);
};
const num = (v: FormDataEntryValue | null) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : 0; };

function launch(id: number, stage: string) {
  after(async () => {
    try {
      const db = await getDb();
      await executeSession(db, id, (s, signal) => runStage(s, "manual", { signal }));
    } catch (error) {
      writeStageLog(stage, "error", error instanceof Error ? error.message : "Session failed");
    }
  });
}

export async function startSessionAction(form: FormData) {
  await guard();
  const db = await getDb();
  const res = await createSession(db, String(form.get("stage") ?? ""), { taskId: num(form.get("taskId")) || undefined });
  if (!res.ok) done(res.error, false);
  else { launch(res.session.id, res.session.stage); done(`Started ${res.session.stage} session #${res.session.id}`); }
}

export async function cancelSessionAction(form: FormData) {
  await guard();
  const res = await cancelSession(await getDb(), num(form.get("id")));
  if (res.ok) done("Cancel requested"); else done(res.error, false);
}

export async function retrySessionAction(form: FormData) {
  await guard();
  const res = await retrySession(await getDb(), num(form.get("id")));
  if (!res.ok) done(res.error, false);
  else { launch(res.session.id, res.session.stage); done(`Retrying as session #${res.session.id}`); }
}

export async function createTaskAction(form: FormData) {
  await guard();
  const res = await createTask(await getDb(), { title: form.get("title"), notes: form.get("notes"), stage: form.get("stage") });
  if (res.ok) done(`Task “${res.task.title}” added`); else done(res.error, false);
}

export async function updateTaskAction(form: FormData) {
  await guard();
  const patch: { status?: string; stage?: string } = {};
  if (form.get("status")) patch.status = String(form.get("status"));
  if (form.get("stage")) patch.stage = String(form.get("stage"));
  const res = await updateTask(await getDb(), num(form.get("id")), patch);
  if (res.ok) done("Task updated"); else done(res.error, false);
}

export async function deleteTaskAction(form: FormData) {
  await guard();
  await deleteTask(await getDb(), num(form.get("id")));
  done("Task deleted");
}
