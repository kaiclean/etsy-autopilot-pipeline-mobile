import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { boxJobs } from "@/db/box-jobs";
import { setImageProviderForTests } from "@/adapters/image";
import { setLLMProviderForTests } from "@/adapters/llm";
import { MockLLMProvider } from "@/adapters/llm/mock";
import { encodeRgbPng } from "@/lib/png";
import { runStage } from "@/pipeline/runner";
import { createHash } from "node:crypto";
vi.mock("@/pipeline/upscale", () => ({ upscaleArtwork: async (url: string) => ({ url, upscaleMethod: "native", sourcePx: { width: 1365, height: 2048 }, outputPx: { width: 1365, height: 2048 } }) }));
import { makeProductOrigin, originPrompt } from "@/lib/brain/product-origin";
import { sendToPipeline } from "@/lib/brain/decisions";
import { stageSucceededToday } from "@/pipeline/chain-day";
import type { Note, Vault } from "@/lib/brain/vault";
const reel: Note = { id: "Reels/alps", name: "alps", title: "Mountain inspiration", kind: "reel", body: "A saved creator's reel", data: { url: "https://www.instagram.com/reel/abc123/" }, tags: [], links: [] };
const idea: Note = { ...reel, id: "Ideas/alpine", name: "alpine", title: "Alpine artwork", kind: "idea", data: { source_reels: ["[[alps]]"] }, body: "Original idea note" };
const vault: Vault = { notes: [reel, idea], byId: new Map([[reel.id,reel],[idea.id,idea]]), loadedAt: 1 };
const direction = "Original gouache mountain lake scene with three peaks and a copper dawn palette";
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); setImageProviderForTests(null); setLLMProviderForTests(null); });
describe("reel to original product brief", () => {
  it("preserves canonical source evidence and explicitly rejects copying", () => {
    const origin = makeProductOrigin(idea, vault, "wall-art", direction);
    expect(origin.reels[0]).toMatchObject({ id: reel.id, url: reel.data.url });
    expect(origin.reels[0].hash).toHaveLength(64);
    expect(originPrompt(origin)).toContain(direction);
    expect(originPrompt(origin)).toContain("Do not copy a reel frame");
  });
  it("blocks missing sources, generic briefs and unsupported files", () => {
    expect(() => makeProductOrigin({ ...idea, data: { source_reels: ["[[missing]]"] } }, vault, "wall-art", direction)).toThrow(/missing/);
    expect(() => makeProductOrigin(reel, vault, "planner", direction)).toThrow(/hand-built/);
    expect(() => makeProductOrigin(reel, vault, "wall-art", "copy it")).toThrow(/30/);
  });
  it("carries the reel brief through Design and Listing to a measured file, without touching unrelated keywords or publishing", async () => {
    vi.stubEnv("DEMO_MODE", "false");
    vi.stubEnv("AUTOPILOT_BOX_WORKER", "1");
    vi.stubEnv("APP_URL", "https://cdn.example");
    const client = new PGlite("memory://");
    const db = drizzle(client, { schema }) as DB;
    try {
      await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
      const [shop] = await db.select().from(schema.shops).limit(1);
      const origin = makeProductOrigin(idea, vault, "wall-art", direction);
      const sent = await sendToPipeline({ phrase: "alpine lake dawn art", niche: "alpine", product: "wall-art", origin }, "test", { db, shopId: shop.id });
      const [other] = await db.insert(schema.keywords).values({ shopId: shop.id, phrase: "unrelated dark forest art", niche: "gothic", status: "selected", source: "test", isDemo: false }).returning();
      const bytes = encodeRgbPng({ width: 1365, height: 2048, rgb: Uint8Array.from({ length: 1365 * 2048 * 3 }, (_, i) => i % 251) });
      vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(bytes), { headers: { "content-type": "image/png" } })));
      const generate = vi.fn(async (request: { prompt: string }) => { expect(request.prompt).toContain(direction); return { url: "https://cdn.example/original-fixture.png", provider: "integration-fixture", costChf: 0 }; });
      setImageProviderForTests({ name: "integration-fixture", estimatedCostChf: 0, generate });
      const copy = new MockLLMProvider();
      setLLMProviderForTests({ name: "integration-fixture", writeListing: b => copy.writeListing(b), assessImage: async () => ({ score: 9, text: false, empty: false, frameOnly: false, artifacts: false, defects: [] }) });
      const run = await runStage("daily", "manual", { db, shopId: shop.id, keywordId: sent.keywordId!, force: true });
      expect(run.status).not.toBe("failed");
      expect(generate).toHaveBeenCalledOnce();
      expect(generate.mock.calls[0]?.[0]).toBeDefined();
      const args = (generate.mock.calls as unknown as [{ prompt: string }][])[0][0];
      expect(args.prompt).toContain(direction);
      const generated = await db.select().from(schema.designs);
      expect(generated).toHaveLength(1);
      expect(generated[0]).toMatchObject({ keywordId: sent.keywordId, isDemo: false, provider: "integration-fixture" });
      const rows = await db.select().from(schema.listings);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every(l => l.keywordId === sent.keywordId && l.productType === "digital" && l.status !== "published" && l.status !== "approved")).toBe(true);
      expect(rows[0].fileManifest?.delivery.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect((await db.select().from(schema.keywords).where(eq(schema.keywords.id, other.id)))[0].status).toBe("selected");
    } finally { await client.close(); }
  });
  it("creates an explicit digital brief and one scoped Mac job without changing publish mode", async () => {
    vi.stubEnv("AUTOPILOT_EXECUTION", "box"); vi.stubEnv("DEMO_MODE", "false");
    const client = new PGlite("memory://");
    const db = drizzle(client, { schema }) as DB;
    try {
      await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
      const [shop] = await db.select().from(schema.shops).limit(1);
      const origin = makeProductOrigin(idea, vault, "wall-art", direction);
      const req = { phrase: "copper alpine mountain wall art", niche: "alpine" as const, product: "wall-art" as const, origin };
      const first = await sendToPipeline(req, "reel-idea:test", { db, shopId: shop.id });
      const again = await sendToPipeline(req, "reel-idea:test", { db, shopId: shop.id });
      expect(again.keywordId).toBe(first.keywordId);
      const [brief] = await db.select().from(schema.designBriefs).where(eq(schema.designBriefs.keywordId, first.keywordId!));
      expect(brief).toMatchObject({ productType: "digital", podPreset: null, isDemo: false, brainOrigin: origin });
      expect(brief.prompt).toContain(direction);
      const jobs = await db.select().from(boxJobs);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ stage: "daily", keywordId: first.keywordId, force: true, status: "queued" });
      expect(await db.select().from(schema.listings)).toHaveLength(0);
      await expect(sendToPipeline({ ...req, origin: { ...origin, direction: direction + " different" } }, "test", { db, shopId: shop.id })).rejects.toThrow(/different product brief/);
      await db.insert(schema.jobRuns).values({ shopId: shop.id, keywordId: first.keywordId, stage: "daily", trigger: "manual", status: "success" });
      expect(await stageSucceededToday(db, shop.id, "daily", new Date())).toBe(false);
    } finally { await client.close(); }
  });
});
