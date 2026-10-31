"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import { config } from "@/lib/config";
import { getDb } from "@/db";
import { listThemes, themeRunnable } from "@/lib/themes";
import { defaultDirection, isArtProduct, makeProductOrigin, reviseProductOrigin } from "@/lib/brain/product-origin";
import type { Note } from "@/lib/brain/vault";
import { ideaCandidates } from "@/db/schema";
import { eq } from "drizzle-orm";
import { generateIdeaCandidates } from "@/lib/brain/idea-feed";
import { getVault } from "@/lib/brain/vault";
import { cleanPhrase } from "@/lib/brain/fit";
import { mapIdea } from "@/lib/brain/mapper";
import { decide, decideCandidate, VERDICTS, type PipelineRequest, type Verdict } from "@/lib/brain/decisions";

async function requireSession(next: string) {
  if (!(await verifySessionToken((await cookies()).get(SESSION_COOKIE)?.value, config.authSecret))) redirect(`/login?next=${next}`);
}

/** Reads the confirmed theme + phrase. Returns a request, null (not confirmed) or an error code. */
async function confirmedPipeline(form: FormData, note?: Note): Promise<PipelineRequest | null | "phrase" | "theme" | "brief"> {
  if (form.get("confirm") !== "on") return null;
  const phrase = cleanPhrase(String(form.get("phrase") ?? ""));
  if (!phrase) return "phrase";
  const theme = (await listThemes(await getDb())).find((t) => t.id === String(form.get("theme") ?? ""));
  if (!theme || !themeRunnable(theme)) return "theme";
  const product = form.get("product") ?? "wall-art";
  if (!isArtProduct(product) || !theme.products.includes(product)) return "theme";
  let origin;
  try { origin = note ? makeProductOrigin(note, getVault(), product, String(form.get("direction") ?? defaultDirection(note))) : undefined; }
  catch { return "brief"; }
  return { phrase, niche: theme.baseNiche, themeId: theme.id, product, origin };
}

export async function decideIdea(form: FormData) {
  await requireSession("/brain/ideas");
  const ideaId = String(form.get("idea") ?? "");
  const verdict = String(form.get("verdict") ?? "") as Verdict;
  const note = getVault().byId.get(ideaId);
  if (!note || !["idea", "reel"].includes(note.kind) || !VERDICTS.includes(verdict)) redirect("/brain/ideas?msg=bad");
  const comment = String(form.get("comment") ?? "").trim().slice(0, 2000) || null;
  const p = Number.parseInt(String(form.get("priority") ?? ""), 10);
  const priority = Number.isFinite(p) ? Math.min(Math.max(p, 1), 5) : null;

  let pipeline: PipelineRequest | null = null;
  if (verdict === "approved") {
    const mapping = mapIdea(note, await listThemes(await getDb()));
    const artwork = note.kind === "reel" || mapping.kind === "product" && mapping.product && ["wall-art", "poster", "pod-apparel", "pod-mug"].includes(mapping.product);
    const req = artwork ? await confirmedPipeline(form, note) : null;
    if (req === "phrase" || req === "theme" || req === "brief") redirect(`/brain/ideas?msg=${req}`);
    pipeline = req;
    if (note.kind === "reel" && !pipeline) redirect("/brain/ideas?msg=confirm");
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
    const [candidate] = await (await getDb()).select().from(ideaCandidates).where(eq(ideaCandidates.id, id)).limit(1);
    const req = await confirmedPipeline(form);
    if (req === null) redirect("/brain/ideas?msg=confirm#candidates");
    if (req === "phrase" || req === "theme" || req === "brief") redirect(`/brain/ideas?msg=${req}#candidates`);
    pipeline = req;
    if (candidate?.brainOrigin && req.product) {
      try { pipeline = { ...req, origin: reviseProductOrigin(candidate.brainOrigin, req.product, String(form.get("direction") ?? "")) }; }
      catch { redirect("/brain/ideas?msg=brief"); }
    }
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

export async function refreshReelIdeas() {
  await requireSession("/brain/ideas");
  await generateIdeaCandidates(await getDb());
  revalidatePath("/brain", "layout");
  redirect("/brain/ideas#candidates");
}
