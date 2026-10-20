"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import { config } from "@/lib/config";
import { getDb } from "@/db";
import { listThemes, themeRunnable } from "@/lib/themes";
import { getVault } from "@/lib/brain/vault";
import { cleanPhrase } from "@/lib/brain/fit";
import { mapIdea } from "@/lib/brain/mapper";
import { decide, decideCandidate, VERDICTS, type PipelineRequest, type Verdict } from "@/lib/brain/decisions";

async function requireSession(next: string) {
  if (!(await verifySessionToken((await cookies()).get(SESSION_COOKIE)?.value, config.authSecret))) redirect(`/login?next=${next}`);
}

/** Reads the confirmed theme + phrase. Returns a request, null (not confirmed) or an error code. */
async function confirmedPipeline(form: FormData): Promise<PipelineRequest | null | "phrase" | "theme"> {
  if (form.get("confirm") !== "on") return null;
  const phrase = cleanPhrase(String(form.get("phrase") ?? ""));
  if (!phrase) return "phrase";
  const theme = (await listThemes(await getDb())).find((t) => t.id === String(form.get("theme") ?? ""));
  if (!theme || !themeRunnable(theme)) return "theme";
  return { phrase, niche: theme.baseNiche, themeId: theme.id };
}

export async function decideIdea(form: FormData) {
  await requireSession("/brain/ideas");
  const ideaId = String(form.get("idea") ?? "");
  const verdict = String(form.get("verdict") ?? "") as Verdict;
  const note = getVault().byId.get(ideaId);
  if (!note || note.kind !== "idea" || !VERDICTS.includes(verdict)) redirect("/brain/ideas?msg=bad");
  const comment = String(form.get("comment") ?? "").trim().slice(0, 2000) || null;
  const p = Number.parseInt(String(form.get("priority") ?? ""), 10);
  const priority = Number.isFinite(p) ? Math.min(Math.max(p, 1), 5) : null;

  let pipeline: PipelineRequest | null = null;
  if (verdict === "approved") {
    const mapping = mapIdea(note, await listThemes(await getDb()));
    const artwork = mapping.kind === "product" && mapping.product && ["wall-art", "poster", "pod-apparel", "pod-mug"].includes(mapping.product);
    const req = artwork ? await confirmedPipeline(form) : null;
    if (req === "phrase" || req === "theme") redirect(`/brain/ideas?msg=${req}`);
    pipeline = req;
  }
  let msg = "saved";
  try {
    const r = await decide({ ideaId, verdict, comment, priority, pipeline });
    if (r.keywordId) msg = r.note ? "existing" : "pipeline";
    else if (verdict === "approved") msg = "backlog";
  } catch (e) {
    console.error("brain: decide failed:", (e as Error).message);
    msg = "error";
  }
  revalidatePath("/brain", "layout");
  redirect(`/brain/ideas?msg=${msg}`);
}

export async function decideCandidateAction(form: FormData) {
  await requireSession("/brain/ideas");
  const id = Number(form.get("candidate"));
  const verdict = String(form.get("verdict")) === "approved" ? "approved" : "rejected";
  let pipeline: PipelineRequest | null = null;
  if (verdict === "approved") {
    const req = await confirmedPipeline(form);
    if (req === null) redirect("/brain/ideas?msg=confirm#candidates");
    if (req === "phrase" || req === "theme") redirect(`/brain/ideas?msg=${req}#candidates`);
    pipeline = req;
  }
  let msg = verdict === "approved" ? "pipeline" : "dismissed";
  try {
    const r = await decideCandidate(id, verdict, pipeline);
    if (verdict === "approved" && r.note) msg = "existing";
  } catch (e) {
    console.error("brain: candidate failed:", (e as Error).message);
    msg = "error";
  }
  revalidatePath("/brain", "layout");
  redirect(`/brain/ideas?msg=${msg}#candidates`);
}
