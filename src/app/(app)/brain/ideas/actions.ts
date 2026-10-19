"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import { config } from "@/lib/config";
import { activeNiches } from "@/lib/niches";
import type { Niche } from "@/db/schema";
import { getVault } from "@/lib/brain/vault";
import { cleanPhrase, themeFit } from "@/lib/brain/fit";
import { decide, VERDICTS, type Verdict } from "@/lib/brain/decisions";

export async function decideIdea(form: FormData) {
  if (!(await verifySessionToken((await cookies()).get(SESSION_COOKIE)?.value, config.authSecret))) redirect("/login?next=/brain/ideas");
  const ideaId = String(form.get("idea") ?? "");
  const verdict = String(form.get("verdict") ?? "") as Verdict;
  const note = getVault().byId.get(ideaId);
  if (!note || note.kind !== "idea" || !VERDICTS.includes(verdict)) redirect("/brain/ideas?msg=bad");
  const comment = String(form.get("comment") ?? "").trim().slice(0, 2000) || null;
  const p = Number.parseInt(String(form.get("priority") ?? ""), 10);
  const priority = Number.isFinite(p) ? Math.min(Math.max(p, 1), 5) : null;

  let pipeline: { phrase: string; niche: Niche } | null = null;
  if (verdict === "approved" && form.get("confirm") === "on" && themeFit(note)) {
    const phrase = cleanPhrase(String(form.get("phrase") ?? ""));
    const niche = String(form.get("niche") ?? "") as Niche;
    if (!phrase) redirect(`/brain/ideas?msg=phrase#${encodeURIComponent(ideaId)}`);
    if (!activeNiches().some((n) => n.id === niche)) redirect("/brain/ideas?msg=niche");
    pipeline = { phrase, niche };
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
