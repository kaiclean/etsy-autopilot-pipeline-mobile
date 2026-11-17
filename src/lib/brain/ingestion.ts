import { eq, sql } from "drizzle-orm";
import type { DB } from "@/db";
import { brainVaultNotes, settings } from "@/db/schema";
import { parseFrontMatter, type Vault } from "./vault";

export const INGEST_KEY = "brain.ingestion";
export const MAX_INGEST_BYTES = 1_000_000;
export type IngestRun = {
  id: string; status: "running" | "succeeded" | "failed"; startedAt: string; finishedAt?: string;
  scanned: number; analysed: number; skipped: number; failed: number; pending: number;
  error?: "instagram_login" | "instagram_fetch" | "media" | "transcription" | "analysis" | "sync" | "configuration" | "partial_failure";
};
export type IngestStatus = { lastRun: IngestRun | null; lastSuccessAt: string | null };
export type NoteImport = { id: string; markdown: string };
const ERRORS = ["instagram_login", "instagram_fetch", "media", "transcription", "analysis", "sync", "configuration", "partial_failure"];

export function validateIngest(input: unknown): { run: IngestRun; notes: NoteImport[] } {
  if (!input || typeof input !== "object") throw new Error("Expected an import object");
  const { run, notes = [] } = input as { run: IngestRun; notes: NoteImport[] };
  const validTime = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v));
  if (!run || !/^[a-zA-Z0-9_-]{1,100}$/.test(run.id) || !["running", "succeeded", "failed"].includes(run.status)
    || !validTime(run.startedAt) || (run.status !== "running" && (!validTime(run.finishedAt) || Date.parse(run.finishedAt!) < Date.parse(run.startedAt)))
    || ["scanned", "analysed", "skipped", "failed", "pending"].some(k => !Number.isSafeInteger(run[k as keyof IngestRun]) || Number(run[k as keyof IngestRun]) < 0)
    || (run.error && !ERRORS.includes(run.error)) || run.status === "succeeded" && (run.failed > 0 || run.error)) throw new Error("Invalid run status");
  if (!Array.isArray(notes) || notes.length > 8) throw new Error("Import at most eight notes per request");
  const ids = new Set<string>();
  const clean = notes.map(n => {
    if (!n || typeof n.id !== "string" || !/^(Reels|Ideas)\/[^/\\\x00-\x1f]{1,200}$/.test(n.id)
      || n.id.includes("..") || n.id.endsWith(".md") || ids.has(n.id) || typeof n.markdown !== "string"
      || n.markdown.length > 120_000 || n.markdown.length < 40) throw new Error("Invalid note");
    ids.add(n.id);
    const { data, content } = parseFrontMatter(n.markdown);
    if (!content.trim()) throw new Error("Empty note");
    if (n.id.startsWith("Reels/")) {
      if (typeof data.shortcode !== "string" || !/^[A-Za-z0-9_-]{3,40}$/.test(data.shortcode)
        || !["summarized", "transcribed"].includes(String(data.status))
        || data.url !== `https://www.instagram.com/reel/${data.shortcode}/`) throw new Error("Reel needs a canonical source and analysis status");
    } else if (!["product", "saas", "software", "project", "content"].includes(String(data.type))
      || !Array.isArray(data.source_reels) || !data.source_reels.length) throw new Error("Idea needs a type and source reels");
    return { id: n.id, markdown: n.markdown };
  });
  // Allow only operational fields; no arbitrary error text, credentials or commands in status.
  return { run: { id: run.id, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt,
    scanned: run.scanned, analysed: run.analysed, skipped: run.skipped, failed: run.failed, pending: run.pending, error: run.error }, notes: clean };
}

export function validateSources(notes: NoteImport[], vault: Vault) {
  const imports = new Map(notes.map(n => [n.id, parseFrontMatter(n.markdown).data]));
  for (const n of notes) {
    const data = imports.get(n.id)!;
    if (n.id.startsWith("Reels/")) {
      const existing = vault.notes.find(x => x.kind === "reel" && x.data.shortcode === data.shortcode);
      if (existing && existing.id !== n.id) throw new Error("Use the existing note id for this shortcode");
    } else for (const ref of data.source_reels as unknown[]) {
      if (typeof ref !== "string" || !/^\[\[Reels\/.+\]\]$/.test(ref)) throw new Error("Invalid source reel reference");
      const id = ref.slice(2, -2);
      if (!imports.has(id) && vault.byId.get(id)?.kind !== "reel") throw new Error("Source reel is missing");
    }
  }
}

export async function ingestionStatus(db: DB): Promise<IngestStatus> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, INGEST_KEY)).limit(1);
  return (row?.value as IngestStatus) ?? { lastRun: null, lastSuccessAt: null };
}
export function ingestionHealth(status: IngestStatus, now = new Date()) {
  const run = status.lastRun;
  if (!run) return "not-connected";
  const age = now.getTime() - Date.parse(run.finishedAt ?? run.startedAt);
  if (run.status === "running") return age > 3 * 3600_000 ? "stalled" : "running";
  if (run.status === "failed") return "failed";
  return age > 36 * 3600_000 ? "overdue" : "healthy";
}

/** One SQL statement per note is safe to retry; checkpoints follow the durable note writes. */
export async function importNotes(db: DB, notes: NoteImport[]) {
  if (!notes.length) return;
  await db.insert(brainVaultNotes).values(notes).onConflictDoUpdate({ target: brainVaultNotes.id,
    set: { markdown: sql`excluded.markdown`, updatedAt: new Date() },
    setWhere: sql`${brainVaultNotes.markdown} IS DISTINCT FROM excluded.markdown`,
  });
}
export async function recordIngestRun(db: DB, run: IngestRun) {
  const current = await ingestionStatus(db);
  const value: IngestStatus = { lastRun: run, lastSuccessAt: run.status === "succeeded" ? run.finishedAt! : current.lastSuccessAt };
  // Ignore stale deliveries from older runs or a delayed in-progress request after completion.
  await db.insert(settings).values({ key: INGEST_KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() },
    setWhere: sql`(${settings.value}->'lastRun'->>'startedAt') < ${run.startedAt} OR ((${settings.value}->'lastRun'->>'id') = ${run.id} AND ((${settings.value}->'lastRun'->>'status') = 'running' OR ${run.status} <> 'running'))`,
  });
}
