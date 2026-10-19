import { desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { brainDecisions, keywords, type BrainDecision, type Niche } from "@/db/schema";
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

export type DecideInput = {
  ideaId: string; verdict: Verdict; comment: string | null; priority: number | null;
  /** Present only when Kai confirmed a phrase for a theme-fitting idea. */
  pipeline?: { phrase: string; niche: Niche } | null;
};

/**
 * Records a decision. With a confirmed pipeline phrase it also creates (or reuses) a `selected`
 * keyword and its design brief, so the next design run picks it up. Never publishes anything:
 * the listing still lands in the approval queue behind the quality gate.
 * neon-http has no interactive transactions; each step is idempotent (unique phrase, one brief per keyword).
 */
export async function decide(input: DecideInput) {
  const db = await getDb();
  let keywordId: number | null = null, designBriefId: number | null = null;
  let note = "";
  if (input.verdict === "approved" && input.pipeline) {
    const { phrase, niche } = input.pipeline;
    if (!activeNiches().some((n) => n.id === niche)) throw new Error("That theme is paused or unknown");
    const shop = await resolveRequestShop(db);
    const demo = isDemoMode(shop.id);
    const now = new Date();
    const [inserted] = await db.insert(keywords).values({
      shopId: shop.id, phrase, niche, source: `omnibrain:${input.ideaId}`.slice(0, 200),
      demandScore: 0.7, competitionScore: 0.5, seasonalityScore: 0.5, score: 0.9, status: "selected", isDemo: demo,
    }).onConflictDoNothing({ target: keywords.phrase }).returning();
    let kw = inserted;
    if (!kw) {
      [kw] = await db.select().from(keywords).where(eq(keywords.phrase, phrase)).limit(1);
      if (kw && kw.status === "new") { await db.update(keywords).set({ status: "selected", updatedAt: now }).where(eq(keywords.id, kw.id)); note = "existing keyword selected"; }
      else note = `keyword already ${kw?.status ?? "missing"}`;
    }
    if (kw) {
      keywordId = kw.id;
      const ctx = { db, shopId: shop.id, demo, trigger: "manual" as const, random: Math.random, now, log: () => {} };
      const concept = chooseConcept(kw.niche, [], kw.phrase) ?? undefined;
      const prompt = buildPrompt(kw.phrase, NICHES[kw.niche].style, kw.niche, concept);
      const { brief } = await ensureDesignBrief(ctx, { id: kw.id, phrase: kw.phrase, niche: kw.niche }, prompt, concept);
      designBriefId = brief?.id ?? null;
    }
  }
  const [row] = await db.insert(brainDecisions).values({
    ideaId: input.ideaId, verdict: input.verdict, comment: input.comment, priority: input.priority,
    phrase: input.pipeline?.phrase ?? null, niche: input.pipeline?.niche ?? null, keywordId, designBriefId,
  }).returning();
  return { decision: toDecision(row), keywordId, designBriefId, note };
}

/** Pipeline status for linked keywords, for the idea cards. */
export async function keywordStatuses(ids: number[]) {
  if (!ids.length) return new Map<number, string>();
  const db = await getDb();
  const rows = await db.select({ id: keywords.id, status: keywords.status }).from(keywords).where(inArray(keywords.id, ids));
  return new Map(rows.map((r) => [r.id, r.status]));
}

