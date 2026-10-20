import { desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { brainDecisions, ideaCandidates, keywords, type BrainDecision, type Niche } from "@/db/schema";
import { themeStyles } from "@/lib/themes";
import { ensureDesignBrief } from "@/pipeline/design-brief";
import { buildPrompt, chooseConcept } from "@/pipeline/design";
import { NICHES, activeNiches } from "@/lib/niches";
import { isDemoMode } from "@/lib/config";
import { resolveRequestShop } from "@/lib/shops";

export type Verdict = BrainDecision["verdict"];
export type Decision = Omit<BrainDecision, "createdAt" | "verdict"> & { verdict: Verdict; created_at: string; idea_id: string };
export const VERDICTS: Verdict[] = ["approved", "rejected", "needs_research"];

/** Autopilot always has a database (Neon in prod, PGlite locally). */
export function dbEnabled() { return true; }

function toDecision(r: BrainDecision): Decision {
  return { ...r, idea_id: r.ideaId, created_at: r.createdAt.toISOString() };
}

export async function listDecisions(since?: Date): Promise<Decision[]> {
  const db = await getDb();
  const rows = await db.select().from(brainDecisions).orderBy(desc(brainDecisions.createdAt)).limit(1000);
  return rows.filter((r) => !since || r.createdAt > since).map(toDecision);
}

export async function latestByIdea(): Promise<Map<string, Decision>> {
  const m = new Map<string, Decision>();
  try { for (const d of await listDecisions()) if (!m.has(d.idea_id)) m.set(d.idea_id, d); }
  catch (e) { console.error("brain: decisions read failed:", (e as Error).message); }
  return m;
}

export type PipelineRequest = { phrase: string; niche: Niche; themeId?: string | null };
export type DecideInput = {
  ideaId: string; verdict: Verdict; comment: string | null; priority: number | null;
  /** Present only when Kai confirmed a phrase for a pipeline-ready idea. */
  pipeline?: PipelineRequest | null;
};

/**
 * Creates (or reuses) a `selected` keyword and its design brief, so the next design run picks it up.
 * Never publishes: the listing still lands in the approval queue behind the quality gate.
 * neon-http has no interactive transactions; each step is idempotent (unique phrase, one brief per keyword).
 */
export async function sendToPipeline(req: PipelineRequest, source: string) {
  const db = await getDb();
  const { phrase, niche } = req;
  if (!activeNiches().some((n) => n.id === niche)) throw new Error("That theme is paused or unknown");
  const shop = await resolveRequestShop(db);
  const demo = isDemoMode(shop.id);
  const now = new Date();
  let note = "";
  const [inserted] = await db.insert(keywords).values({
    shopId: shop.id, phrase, niche, source: source.slice(0, 200), themeId: req.themeId ?? null,
    demandScore: 0.7, competitionScore: 0.5, seasonalityScore: 0.5, score: 0.9, status: "selected", isDemo: demo,
  }).onConflictDoNothing({ target: keywords.phrase }).returning();
  let kw = inserted;
  if (!kw) {
    [kw] = await db.select().from(keywords).where(eq(keywords.phrase, phrase)).limit(1);
    if (kw && kw.status === "new") { await db.update(keywords).set({ status: "selected", updatedAt: now }).where(eq(keywords.id, kw.id)); note = "existing keyword selected"; }
    else note = `keyword already ${kw?.status ?? "missing"}`;
  }
  if (!kw) return { keywordId: null, designBriefId: null, note };
  const ctx = { db, shopId: shop.id, demo, trigger: "manual" as const, random: Math.random, now, log: () => {} };
  const concept = chooseConcept(kw.niche, [], kw.phrase) ?? undefined;
  const themeStyle = kw.themeId ? (await themeStyles(db, [kw.themeId])).get(kw.themeId) : undefined;
  const prompt = themeStyle ? buildPrompt(kw.phrase, themeStyle, undefined, concept) : buildPrompt(kw.phrase, NICHES[kw.niche].style, kw.niche, concept);
  const { brief } = await ensureDesignBrief(ctx, { id: kw.id, phrase: kw.phrase, niche: kw.niche }, prompt, concept);
  return { keywordId: kw.id, designBriefId: brief?.id ?? null, note };
}

/** Records a decision; with a confirmed pipeline request it also sends the idea to the pipeline. */
export async function decide(input: DecideInput) {
  const db = await getDb();
  let keywordId: number | null = null, designBriefId: number | null = null, note = "";
  if (input.verdict === "approved" && input.pipeline) {
    ({ keywordId, designBriefId, note } = await sendToPipeline(input.pipeline, `omnibrain:${input.ideaId}`));
  }
  const [row] = await db.insert(brainDecisions).values({
    ideaId: input.ideaId, verdict: input.verdict, comment: input.comment, priority: input.priority,
    phrase: input.pipeline?.phrase ?? null, niche: input.pipeline?.niche ?? null, keywordId, designBriefId,
  }).returning();
  return { decision: toDecision(row), keywordId, designBriefId, note };
}

/** Approve or reject a daily idea candidate. Approval requires the confirmed phrase (same rule as ideas). */
export async function decideCandidate(id: number, verdict: "approved" | "rejected", pipeline: PipelineRequest | null) {
  const db = await getDb();
  const [c] = await db.select().from(ideaCandidates).where(eq(ideaCandidates.id, id)).limit(1);
  if (!c || c.status !== "pending") throw new Error("Candidate not found or already decided");
  let keywordId: number | null = null, designBriefId: number | null = null, note = "";
  if (verdict === "approved") {
    if (!pipeline) throw new Error("Confirm the search phrase to approve");
    ({ keywordId, designBriefId, note } = await sendToPipeline(pipeline, `brain-feed:${c.source}`));
  }
  await db.update(ideaCandidates).set({ status: verdict, keywordId, designBriefId, decidedAt: new Date(),
    ...(pipeline ? { phrase: pipeline.phrase, niche: pipeline.niche, themeId: pipeline.themeId ?? c.themeId } : {}) }).where(eq(ideaCandidates.id, id));
  return { keywordId, designBriefId, note };
}

/** Pipeline status for linked keywords, for the idea cards. */
export async function keywordStatuses(ids: number[]) {
  if (!ids.length) return new Map<number, string>();
  const db = await getDb();
  const rows = await db.select({ id: keywords.id, status: keywords.status }).from(keywords).where(inArray(keywords.id, ids));
  return new Map(rows.map((r) => [r.id, r.status]));
}

