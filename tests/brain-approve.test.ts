import path from "node:path";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import { brainDecisions, designBriefs, keywords } from "@/db/schema";
import type { DB } from "@/db";

const database = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ getDb: async () => database.db }));

import { decide, latestByIdea } from "@/lib/brain/decisions";
import { cleanPhrase, themeFit } from "@/lib/brain/fit";
import type { Note } from "@/lib/brain/vault";

const note = (over: Partial<Note> & { data?: Record<string, unknown> }): Note => ({
  id: "Ideas/x", kind: "idea", title: "x", tags: [], links: [], body: "", data: {}, ...over,
} as unknown as Note);

describe("brain decisions", () => {
  beforeAll(async () => {
    const db = drizzle(new PGlite("memory://"), { schema });
    const dir = path.join(process.cwd(), "drizzle");
    await migrate(db, { migrationsFolder: dir });
    await migrate(db, { migrationsFolder: dir }); // re-run is a no-op
    database.db = db as unknown as DB;
  });

  it("keeps a backlog approval out of the pipeline", async () => {
    const before = await (database.db as DB).select().from(keywords);
    const r = await decide({ ideaId: "Ideas/Backlog only", verdict: "approved", comment: "later", priority: 3, pipeline: null });
    expect(r.keywordId).toBeNull();
    expect(r.designBriefId).toBeNull();
    expect((await (database.db as DB).select().from(keywords)).length).toBe(before.length);
    expect((await latestByIdea()).get("Ideas/Backlog only")?.verdict).toBe("approved");
  });

  it("creates a selected keyword and a design brief once the phrase is confirmed, idempotently", async () => {
    const db = database.db as DB;
    const r = await decide({ ideaId: "Ideas/Gothic cat", verdict: "approved", comment: null, priority: 1, pipeline: { phrase: "gothic cat tarot print", niche: "gothic" } });
    expect(r.keywordId).toBeTruthy();
    expect(r.designBriefId).toBeTruthy();
    const [kw] = await db.select().from(keywords).where(eq(keywords.id, r.keywordId!));
    expect(kw).toMatchObject({ phrase: "gothic cat tarot print", niche: "gothic", status: "selected", source: "omnibrain:Ideas/Gothic cat" });
    const [brief] = await db.select().from(designBriefs).where(eq(designBriefs.keywordId, kw.id));
    expect(brief.id).toBe(r.designBriefId);
    const again = await decide({ ideaId: "Ideas/Gothic cat", verdict: "approved", comment: null, priority: 1, pipeline: { phrase: "gothic cat tarot print", niche: "gothic" } });
    expect(again.keywordId).toBe(r.keywordId);
    expect(again.designBriefId).toBe(r.designBriefId);
    expect((await db.select().from(keywords).where(eq(keywords.phrase, "gothic cat tarot print"))).length).toBe(1);
    const [d] = await db.select().from(brainDecisions).where(eq(brainDecisions.keywordId, kw.id));
    expect(d.designBriefId).toBe(brief.id);
  });

  it("refuses a paused or unknown theme", async () => {
    await expect(decide({ ideaId: "Ideas/x", verdict: "approved", comment: null, priority: null, pipeline: { phrase: "some thing", niche: "nope" as never } })).rejects.toThrow();
  });
});

describe("theme fit", () => {
  it("only product ideas fit, and they need theme words", () => {
    expect(themeFit(note({ title: "Gothic floral autumn print", tags: ["gothic"], data: { type: "digital product" } }))?.niche).toBe("gothic");
    expect(themeFit(note({ title: "Gothic tarot cat print", data: { type: "software" } }))).toBeNull();
    expect(themeFit(note({ title: "Invoice tracker", data: { type: "digital product" } }))).toBeNull();
  });
  it("cleans phrases", () => {
    expect(cleanPhrase("  Gothic  CAT print!! ")).toBe("gothic cat print");
    expect(cleanPhrase("cat")).toBeNull();
  });
});
