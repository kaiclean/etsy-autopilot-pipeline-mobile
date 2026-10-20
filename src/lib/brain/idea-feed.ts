import { and, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import type { DB } from "@/db";
import { hotSignals, ideaCandidates, keywords, themes, type Theme } from "@/db/schema";
import { PIPELINE_PRODUCTS, ensureThemeSeeds, listThemes, slugify, themeRunnable } from "@/lib/themes";
import { keywordHasUndeliverablePromise } from "@/lib/delivery";
import { getVault } from "./vault";
import { mapIdea } from "./mapper";

const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const DAILY_CANDIDATE_LIMIT = 8;

type Draft = typeof ideaCandidates.$inferInsert;

/** Months 0..2 ahead of `now` (UTC), so seasonal ideas land while there is still time to list. */
export function upcomingMonths(now: Date, ahead = 2) {
  return Array.from({ length: ahead + 1 }, (_, i) => (now.getUTCMonth() + i) % 12);
}

function seasonal(themesList: Theme[], now: Date): Draft[] {
  const soon = new Set(upcomingMonths(now));
  return themesList.filter((t) => themeRunnable(t) && t.peakMonths.some((m) => soon.has(m))).flatMap((t) => {
    const peak = t.peakMonths.find((m) => soon.has(m))!;
    const product = t.products.find((p) => PIPELINE_PRODUCTS.includes(p)) ?? "wall-art";
    return t.seeds.map((phrase) => ({
      key: `season:${t.id}:${phrase}`, title: `${t.label}: ${phrase}`, phrase, themeId: t.id, niche: t.baseNiche, product,
      rationale: `${t.label} peaks in ${MONTH[peak]}; list now so it is indexed before the peak.`, source: `theme:${t.id}`,
    }));
  });
}

const wordsOf = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);

async function trending(db: DB, themesList: Theme[], now: Date): Promise<Draft[]> {
  const since = new Date(now.getTime() - 3 * 864e5);
  const rows = await db.select({ phrase: hotSignals.phrase, provider: hotSignals.provider, title: hotSignals.title })
    .from(hotSignals).where(gte(hotSignals.createdAt, since)).orderBy(desc(hotSignals.score)).limit(40);
  const runnable = themesList.filter(themeRunnable);
  return rows.flatMap((r) => {
    const w = new Set(wordsOf(r.phrase));
    const theme = runnable.map((t) => ({ t, n: new Set([...wordsOf(t.label), ...t.seeds.flatMap(wordsOf)].filter((x) => w.has(x))).size }))
      .sort((a, b) => b.n - a.n)[0];
    if (!theme || theme.n < 1) return [];
    const product = theme.t.products.find((p) => PIPELINE_PRODUCTS.includes(p)) ?? "wall-art";
    return [{ key: `hot:${r.phrase}`, title: `Trending: ${r.phrase}`, phrase: r.phrase, themeId: theme.t.id, niche: theme.t.baseNiche, product,
      rationale: `Trending signal from ${r.provider} (“${r.title.slice(0, 80)}”), fits ${theme.t.label}.`, source: `hot:${r.provider}` }];
  });
}

/** Vault ideas that are artwork products but match no theme become proposed themes for Kai. */
async function proposedThemes(db: DB, themesList: Theme[]) {
  let added = 0;
  for (const n of getVault().notes.filter((x) => x.kind === "idea")) {
    const m = mapIdea(n, themesList);
    if (m.kind !== "product" || m.theme || !m.product || !PIPELINE_PRODUCTS.includes(m.product) || !m.phrase) continue;
    const id = slugify(`idea-${n.title}`);
    const res = await db.insert(themes).values({
      id, label: n.title.slice(0, 80), baseNiche: "alpine", status: "proposed", seeds: [m.phrase], products: [m.product],
      notes: `Proposed from Brain idea ${n.id}. Check the base niche and look before activating.`, source: `brain:${n.id}`,
    }).onConflictDoNothing({ target: themes.id }).returning({ id: themes.id });
    added += res.length;
  }
  return added;
}

/**
 * The daily idea step. Rule-based: no AI calls, no image spend. Adds at most
 * DAILY_CANDIDATE_LIMIT pending candidates (skipping phrases that are already keywords or candidates)
 * and proposes themes for unmatched artwork ideas. Nothing reaches the pipeline until Kai approves.
 */
export async function generateIdeaCandidates(db: DB, now = new Date()) {
  await ensureThemeSeeds(db);
  const themesList = await listThemes(db);
  const drafts = [...seasonal(themesList, now), ...(await trending(db, themesList, now))]
    .map((d) => ({ ...d, phrase: d.phrase.trim().toLowerCase() }))
    .filter((d) => d.phrase.split(" ").length >= 2 && !keywordHasUndeliverablePromise(d.phrase));
  const phrases = [...new Set(drafts.map((d) => d.phrase))];
  const taken = new Set(phrases.length ? (await db.select({ phrase: keywords.phrase }).from(keywords).where(inArray(keywords.phrase, phrases))).map((r) => r.phrase) : []);
  const keys = drafts.map((d) => d.key);
  const known = new Set(keys.length ? (await db.select({ key: ideaCandidates.key }).from(ideaCandidates).where(inArray(ideaCandidates.key, keys))).map((r) => r.key) : []);
  const pendingPhrases = new Set((await db.select({ phrase: ideaCandidates.phrase }).from(ideaCandidates).where(eq(ideaCandidates.status, "pending"))).map((r) => r.phrase));
  let added = 0;
  for (const d of drafts) {
    if (added >= DAILY_CANDIDATE_LIMIT) break;
    if (taken.has(d.phrase) || known.has(d.key) || pendingPhrases.has(d.phrase)) continue;
    const res = await db.insert(ideaCandidates).values(d).onConflictDoNothing({ target: ideaCandidates.key }).returning({ id: ideaCandidates.id });
    if (res.length) { added++; pendingPhrases.add(d.phrase); }
  }
  added += await proposedThemes(db, themesList);
  return added;
}

export async function pendingCandidates(db: DB) {
  return db.select().from(ideaCandidates).where(and(eq(ideaCandidates.status, "pending"), isNull(ideaCandidates.decidedAt))).orderBy(desc(ideaCandidates.createdAt)).limit(60);
}
