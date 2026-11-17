import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { importNotes, ingestionHealth, ingestionStatus, recordIngestRun, validateIngest, validateSources, type IngestRun } from "@/lib/brain/ingestion";
import { getLiveVault, mergeVault } from "@/lib/brain/live-vault";
import { getVault } from "@/lib/brain/vault";
import { mapIdea } from "@/lib/brain/mapper";
import { generateIdeaCandidates } from "@/lib/brain/idea-feed";
import { renderMarkdown } from "@/lib/brain/markdown";
import { GET, POST } from "@/app/api/brain/ingest/route";
const client = new PGlite("memory://");
const db = drizzle(client, { schema }) as DB;
const run: IngestRun = { id: "daily123", status: "running", startedAt: "2026-11-11T07:20:00.000Z", scanned: 1, analysed: 1, skipped: 0, failed: 0, pending: 0 };
const reelId = "Reels/ig-TestDaily123";
const notes = [
  { id: reelId, markdown: '---\nshortcode: "TestDaily123"\nurl: "https://www.instagram.com/reel/TestDaily123/"\nstatus: "summarized"\ndate_processed: "2026-11-11"\n---\n# Alpine lake saved reel\n\n## Summary\nA genuine source observation in this synthetic integration fixture.' },
  { id: "Ideas/ig-TestDaily123-1", markdown: '---\ntype: "product"\nsource_reels: ["[[Reels/ig-TestDaily123]]"]\nstatus: "idea"\n---\n# Alpine mountain lake poster\n\n## Concept\nAn original dawn gouache mountain lake poster with a copper sky and three distant peaks.\n\n## Etsy fit\nOriginal alpine mountain lake wall art, requiring quality and originality review.' },
  { id: "Ideas/ig-TestDaily123-2", markdown: '---\ntype: "saas"\nsource_reels: ["[[Reels/ig-TestDaily123]]"]\nstatus: "idea"\n---\n# Local SaaS workflow tracker\n\n## Concept\nA separate software prototype to help small shops organise their evidence and validation.' },
];
beforeAll(async () => { await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") }); });
afterAll(async () => { await client.close(); });
describe("daily worker → live Brain", () => {
  it("refuses unauthenticated worker access before reading any data", async () => {
    vi.stubEnv("BRAIN_SYNC_TOKEN", "sync-only");
    try {
      expect((await GET(new Request("https://example.com/api/brain/ingest"))).status).toBe(401);
      expect((await POST(new Request("https://example.com/api/brain/ingest", { method: "POST", body: "{}" }))).status).toBe(401);
      expect((await POST(new Request("https://example.com/api/brain/ingest", { method: "POST", headers: { authorization: "Bearer sync-only", "content-length": "1000001" }, body: "{}" }))).status).toBe(413);
    } finally { vi.unstubAllEnvs(); }
  });
  it("validates provenance, input bounds and honest completion state", () => {
    expect(validateIngest({ run, notes }).notes).toHaveLength(3);
    expect(() => validateIngest({ run, notes: [{ ...notes[0], id: "Reels/../secret" }] })).toThrow();
    expect(() => validateIngest({ run: { ...run, status: "succeeded", finishedAt: run.startedAt, failed: 1 }, notes })).toThrow();
    expect(() => validateIngest({ run, notes: [{ ...notes[0], markdown: notes[0].markdown.replace("instagram.com", "example.com") }] })).toThrow();
    expect(() => validateSources([notes[1]], mergeVault(getVault(), []))).toThrow(/missing/);
    expect(() => validateSources(notes, getVault())).not.toThrow();
  });
  it("makes new reels and SaaS ideas searchable, linked and approvable without a deploy; retries do not duplicate", async () => {
    await importNotes(db, notes);
    const [before] = await db.select().from(schema.brainVaultNotes);
    await importNotes(db, notes);
    const rows = await db.select().from(schema.brainVaultNotes);
    expect(rows).toHaveLength(3);
    expect(rows.find(n => n.id === before.id)?.updatedAt).toEqual(before.updatedAt);
    const vault = await getLiveVault(db);
    expect(vault.byId.get(notes[1].id)?.links).toContain(reelId);
    expect(vault.byId.get(notes[2].id)?.links).toContain(reelId);
    expect(mapIdea(vault.byId.get(notes[2].id)!, []).kind).toBe("software");
    expect(mapIdea(vault.byId.get(notes[2].id)!, []).pipelineReady).toBe(false);
    expect(renderMarkdown(`[[${reelId}]]`, vault)).toContain("/brain/note/Reels/ig-TestDaily123");
    await generateIdeaCandidates(db, new Date(run.startedAt), vault);
    const candidates = await db.select().from(schema.ideaCandidates);
    expect(candidates.some(c => c.source === `reel-idea:${notes[1].id}`)).toBe(true);
    expect(candidates.some(c => c.source === `reel-idea:${notes[2].id}`)).toBe(false);
    expect(await db.select().from(schema.keywords)).toHaveLength(0);
    expect(await db.select().from(schema.listings)).toHaveLength(0);
  });
  it("updates historical transcriptions under their original id without duplicating a reel", () => {
    const old = getVault().notes.find(n => n.kind === "reel" && typeof n.data.shortcode === "string")!;
    const updated = { id: old.id, markdown: notes[0].markdown.replaceAll("TestDaily123", String(old.data.shortcode)) };
    expect(() => validateSources([updated], getVault())).not.toThrow();
    expect(() => validateSources([{ ...updated, id: "Reels/another-id" }], getVault())).toThrow(/existing note id/);
    expect(mergeVault(getVault(), [updated]).notes.filter(n => n.data.shortcode === old.data.shortcode)).toHaveLength(1);
  });
  it("reports missing, failed, interrupted and overdue jobs and preserves the last successful check", async () => {
    expect(ingestionHealth(await ingestionStatus(db))).toBe("not-connected");
    await recordIngestRun(db, run);
    expect(ingestionHealth(await ingestionStatus(db), new Date("2026-11-11T11:20:00Z"))).toBe("stalled");
    await recordIngestRun(db, { ...run, status: "succeeded", finishedAt: "2026-11-11T07:25:00.000Z" });
    await recordIngestRun(db, run); // delayed in-progress delivery cannot erase completion
    expect((await ingestionStatus(db)).lastRun?.status).toBe("succeeded");
    expect(ingestionHealth(await ingestionStatus(db), new Date("2026-11-13T07:20:00Z"))).toBe("overdue");
    await recordIngestRun(db, { ...run, id: "tomorrow", startedAt: "2026-11-12T07:20:00.000Z", status: "failed", finishedAt: "2026-11-12T07:21:00.000Z", error: "instagram_login" });
    expect((await ingestionStatus(db)).lastSuccessAt).toBe("2026-11-11T07:25:00.000Z");
    expect(ingestionHealth(await ingestionStatus(db))).toBe("failed");
    await recordIngestRun(db, { ...run, status: "succeeded", finishedAt: "2026-11-11T07:25:00.000Z" });
    expect((await ingestionStatus(db)).lastRun?.id).toBe("tomorrow");
  });
  it("does not turn source or model markdown into executable links or HTML", () => {
    const output = renderMarkdown('[click](javascript:alert%281%29)\n\n<script>alert(1)</script>');
    expect(output).not.toContain('href="javascript:');
    expect(output).not.toContain("<script>");
  });
});
