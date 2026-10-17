import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setImageProviderForTests } from "@/adapters/image";
import { CloudflareImageProvider } from "@/adapters/image/cloudflare";
import { setLLMProviderForTests } from "@/adapters/llm";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { designBriefs, designs, keywords, listings } from "@/db/schema";
import { encodeRgbPng, rgbPng } from "@/lib/png";
import { MockLLMProvider } from "@/adapters/llm/mock";
import { reassessDesigns } from "@/pipeline/reassess-designs";
import { runStage } from "@/pipeline/runner";

const originalDemo = process.env.DEMO_MODE;
afterEach(() => {
  setImageProviderForTests(null);
  setLLMProviderForTests(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (originalDemo === undefined) delete process.env.DEMO_MODE;
  else process.env.DEMO_MODE = originalDemo;
});

describe("live visual gate", () => {
  it.each([false, true])("persists RunPod HTTP diagnostics in activity with fallback=%s", async (fallback) => {
    vi.stubEnv("DEMO_MODE", "false");
    vi.stubEnv("IMAGE_PROVIDER", "runpod");
    vi.stubEnv("IMAGE_FALLBACK_PROVIDER", fallback ? "cloudflare" : "");
    vi.stubEnv("RUNPOD_API_KEY", "private-runpod-token");
    vi.stubEnv("RUNPOD_ENDPOINT_ID", "endpoint");
    vi.stubEnv("RUNPOD_COMFY_WORKFLOW", JSON.stringify({ "6": { inputs: { text: "{{PROMPT}}" } } }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new PGlite("memory://");
    try {
      const db = drizzle(client, { schema }) as DB;
      await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
      await db.insert(keywords).values({ phrase: "swiss alps wall art", niche: "alpine", source: "test", status: "selected", isDemo: false });
      const rgb = Uint8Array.from({ length: 12 * 18 * 3 }, (_, index) => index % 2 ? 220 : 30);
      const bytes = encodeRgbPng({ width: 12, height: 18, rgb });
      vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("api.runpod.ai")
        ? Response.json({ error: "No workers available private-runpod-token" }, { status: 409 })
        : new Response(new Uint8Array(bytes))));
      const cloudflare = vi.spyOn(CloudflareImageProvider.prototype, "generate").mockResolvedValue({
        url: "https://cdn.example/alpine.jpg", costChf: 0, provider: "cloudflare",
      });
      const writer = new MockLLMProvider();
      setLLMProviderForTests({
        name: "test", writeListing: writer.writeListing.bind(writer),
        assessImage: async () => ({ score: 9, defects: [], text: false, empty: false, frameOnly: false, artifacts: false }),
      });
      const run = await runStage("design", "manual", { db, random: () => 0.1 });
      const logs = JSON.stringify(run.logs);
      expect(logs).toContain("HTTP 409");
      expect(logs).toContain("No workers available");
      expect(logs).not.toContain("private-runpod-token");
      if (fallback) {
        expect(run.logs.some((line) => line.level === "warn" && line.msg.includes("fallback cloudflare"))).toBe(true);
        expect((await db.select().from(designs))[0].provider).toBe("cloudflare");
        expect(cloudflare).toHaveBeenCalledOnce();
      } else {
        expect(run.status).toBe("failed");
        expect(await db.select().from(designs)).toHaveLength(0);
        expect(cloudflare).not.toHaveBeenCalled();
      }
    } finally { await client.close(); }
  });

  it("accepts praise notes in Design and Listing and holds unscored legacy art for review", async () => {
    process.env.DEMO_MODE = "false";
    const client = new PGlite("memory://");
    try {
      const db = drizzle(client, { schema }) as DB;
      await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
      await db.insert(keywords).values({ phrase: "swiss alps wall art boho neutral", niche: "alpine", source: "test", status: "selected", isDemo: false });
      const rgb = Uint8Array.from({ length: 12 * 18 * 3 }, (_, index) => index % 2 ? 220 : 30);
      const bytes = encodeRgbPng({ width: 12, height: 18, rgb });
      const image = "https://cdn.example/alpine.png";
      vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(bytes))));
      setImageProviderForTests({ name: "test", estimatedCostChf: 0, generate: async () => ({ url: image, costChf: 0, provider: "test" }) });
      const writer = new MockLLMProvider();
      const assessImage = vi.fn(async () => ({
        score: 9, defects: [], notes: ["Clean illustration", "Strong composition"],
        text: false, empty: false, frameOnly: false, artifacts: false,
      }));
      setLLMProviderForTests({ name: "test", assessImage, writeListing: writer.writeListing.bind(writer) });
      await runStage("design", "manual", { db, random: () => 0.1 });
      const [passing] = await db.select().from(designs);
      expect(passing.status).toBe("generated");
      expect(passing.qualityScore).toBe(9);
      expect(passing.qualityReasons).toEqual([]);
      await db.insert(designs).values({ niche: "alpine", prompt: "legacy", provider: "test", imageUrl: image, isDemo: false });
      await runStage("listing", "manual", { db });
      const rows = await db.select().from(designs);
      expect(rows.find((row) => row.id === passing.id)?.status).toBe("listed");
      expect(rows.find((row) => row.prompt === "legacy")?.status).toBe("needs_review");
      expect((await db.select().from(listings)).length).toBeGreaterThan(0);
      expect(assessImage).toHaveBeenCalledOnce();
    } finally { await client.close(); }
  });

  it("explicitly re-assesses unscored rejected designs without approving listings", async () => {
    const client = new PGlite("memory://");
    try {
      const db = drizzle(client, { schema }) as DB;
      await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
      const [keyword] = await db.insert(keywords).values({ phrase: "legacy alpine", niche: "alpine", source: "test", isDemo: false }).returning();
      await db.insert(designBriefs).values({ keywordId: keyword.id, niche: "alpine", concept: "mountain", prompt: "legacy", productType: "digital", dayKey: "2026-10-10" });
      const rgb = Uint8Array.from({ length: 12 * 18 * 3 }, (_, index) => index % 2 ? 220 : 30);
      const image = `data:image/png;base64,${encodeRgbPng({ width: 12, height: 18, rgb }).toString("base64")}`;
      await db.insert(designs).values([68, 69, 70, 71, 72].map((id) => ({
        id, keywordId: keyword.id, niche: "alpine" as const, prompt: "legacy", provider: "test",
        imageUrl: image, qualityScore: null, status: "rejected" as const, qualityReasons: ["No passing image quality assessment."], isDemo: false,
      })));
      const vision = { name: "test", writeListing: vi.fn(), assessImage: vi.fn(async () => ({
        score: 8, defects: [], notes: ["Balanced composition"], text: false, empty: false, frameOnly: false, artifacts: false,
      })) };
      const ids = [68, 69, 70, 71, 72];
      expect(await reassessDesigns(db, ids, vision)).toHaveLength(5);
      expect((await db.select().from(designs))[0].status).toBe("rejected");
      await reassessDesigns(db, ids, vision, true);
      expect((await db.select().from(designs)).every((row) => row.status === "generated" && row.qualityScore === 8 && row.qualityReasons.length === 0)).toBe(true);
      expect(await reassessDesigns(db, ids, vision, true)).toEqual([]);
      expect(await db.select().from(listings)).toHaveLength(0);
    } finally { await client.close(); }
  });

  it.each(["unsupported", "failed"])("holds artwork for review when vision is %s", async (caseName) => {
    process.env.DEMO_MODE = "false";
    const client = new PGlite("memory://");
    try {
      const db = drizzle(client, { schema }) as DB;
      await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
      await db.insert(keywords).values({ phrase: `winter forest ${caseName}`, niche: "alpine", source: "test", status: "selected", isDemo: false });
      const image = `data:image/png;base64,${rgbPng(12, 18, [25, 25, 25]).toString("base64")}`;
      setImageProviderForTests({ name: "test", estimatedCostChf: 0, generate: async () => ({ url: image, costChf: 0, provider: "test" }) });
      const assessImage = vi.fn(async (url: string) => {
        expect(url).toMatch(/^data:image\/png;base64,/);
        expect(url.length).toBeLessThan(2_000_000);
        throw new Error("vision unavailable");
      });
      setLLMProviderForTests({
        name: "test", writeListing: vi.fn(),
        ...(caseName === "failed" ? { assessImage } : {}),
      });
      const run = await runStage("design", "manual", { db, random: () => 0.1 });
      expect(run.status).not.toBe("failed");
      const [design] = await db.select().from(designs);
      expect(design.status).toBe("needs_review");
      expect(design.qualityScore).toBeNull();
      expect(design.qualityReasons.join(" ")).toMatch(/human image review/i);
      expect(assessImage).toHaveBeenCalledTimes(caseName === "failed" ? 1 : 0);
      await runStage("listing", "manual", { db });
      expect(await db.select().from(listings)).toHaveLength(0);
    } finally {
      await client.close();
    }
  });

  it("retries twice with different seeds, records rejection, and never lists bad art", async () => {
    process.env.DEMO_MODE = "false";
    const client = new PGlite("memory://");
    try {
      const db = drizzle(client, { schema }) as DB;
      await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
      await db.insert(keywords).values({ phrase: "gothic floral shirt", niche: "gothic", source: "test", status: "selected", isDemo: false });
      const seeds: number[] = [];
      const image = `data:image/png;base64,${rgbPng(12, 18, [25, 25, 25]).toString("base64")}`;
      setImageProviderForTests({
        name: "test-image", estimatedCostChf: 0,
        generate: vi.fn(async (req) => {
          seeds.push(req.seed);
          return { url: image, costChf: 0, provider: "test-image" };
        }),
      });
      const assessImage = vi.fn(async () => ({
        score: 2, reasons: ["Empty black center"], text: true, empty: true, frameOnly: true, artifacts: false,
      }));
      setLLMProviderForTests({ name: "test-vision", assessImage, writeListing: vi.fn() });
      const result = await runStage("design", "manual", { db, random: () => 0.2 });
      expect(result.status).toBe("failed");
      expect(seeds).toEqual([200000000, 200000001, 200000002]);
      expect(assessImage).toHaveBeenCalledTimes(3);
      const [design] = await db.select().from(designs);
      expect(design.status).toBe("rejected");
      expect(design.qualityScore).toBe(2);
      expect(design.qualityReasons.join(" ")).toMatch(/signature|text|empty/i);
      await runStage("listing", "manual", { db });
      expect(await db.select().from(listings)).toHaveLength(0);
    } finally {
      await client.close();
    }
  });
});
