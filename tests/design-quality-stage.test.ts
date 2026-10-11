import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setImageProviderForTests } from "@/adapters/image";
import { setLLMProviderForTests } from "@/adapters/llm";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { designBriefs, designs, keywords, listings } from "@/db/schema";
import { encodeRgbPng, rgbPng } from "@/lib/png";
import { MockLLMProvider } from "@/adapters/llm/mock";
import { OpenAILLMProvider } from "@/adapters/llm/openai";
import { reassessDesigns, sanitizeReassessmentError } from "@/pipeline/reassess-designs";
import { runStage } from "@/pipeline/runner";

const originalDemo = process.env.DEMO_MODE;
afterEach(() => {
  setImageProviderForTests(null);
  setLLMProviderForTests(null);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (originalDemo === undefined) delete process.env.DEMO_MODE;
  else process.env.DEMO_MODE = originalDemo;
});

describe("live visual gate", () => {
  it("accepts string praise notes in Design and Listing and holds unscored legacy art for review", async () => {
    process.env.DEMO_MODE = "false";
    const client = new PGlite("memory://");
    try {
      const db = drizzle(client, { schema }) as DB;
      await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
      await db.insert(keywords).values({ phrase: "swiss alps wall art boho neutral", niche: "alpine", source: "test", status: "selected", isDemo: false });
      const rgb = Uint8Array.from({ length: 12 * 18 * 3 }, (_, index) => index % 2 ? 220 : 30);
      const bytes = encodeRgbPng({ width: 12, height: 18, rgb });
      const image = "https://cdn.example/alpine.png";
      vi.stubGlobal("fetch", vi.fn(async (url) => String(url).startsWith("https://llm.example/")
        ? new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
          score: 9, defects: [], notes: "Clean illustration; Strong composition",
          text: false, empty: false, frameOnly: false, artifacts: false,
        }) } }] }))
        : new Response(new Uint8Array(bytes))));
      setImageProviderForTests({ name: "test", estimatedCostChf: 0, generate: async () => ({ url: image, costChf: 0, provider: "test" }) });
      const writer = new MockLLMProvider();
      const provider = new OpenAILLMProvider({ apiKey: "test", baseUrl: "https://llm.example/v1", model: "gemma-test" });
      const assessImage = vi.fn(provider.assessImage.bind(provider));
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

  it("re-scores eligible scored designs only when requested and guards status changes during assessment", async () => {
    const client = new PGlite("memory://");
    try {
      const db = drizzle(client, { schema }) as DB;
      await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
      const [keyword] = await db.insert(keywords).values({ phrase: "rescore alpine", niche: "alpine", source: "test" }).returning();
      await db.insert(designBriefs).values({ keywordId: keyword.id, niche: "alpine", concept: "mountain", prompt: "old", productType: "digital", dayKey: "2026-10-10" });
      const rgb = Uint8Array.from({ length: 12 * 18 * 3 }, (_, index) => index % 2 ? 220 : 30);
      const image = `data:image/png;base64,${encodeRgbPng({ width: 12, height: 18, rgb }).toString("base64")}`;
      await db.insert(designs).values([
        { id: 73, status: "rejected" as const }, { id: 74, status: "generated" as const },
        { id: 75, status: "needs_review" as const }, { id: 76, status: "listed" as const },
        { id: 77, status: "discarded" as const }, { id: 78, status: "rejected" as const, isDemo: true },
        { id: 79, status: "listed" as const }, { id: 80, status: "discarded" as const },
      ].map((row) => ({
        keywordId: keyword.id, niche: "alpine" as const, prompt: "old", provider: "test",
        imageUrl: image, qualityScore: 9, qualityReasons: ["Strong composition"], isDemo: false, ...row,
      })));
      // Legacy or externally-written protected statuses must be excluded too.
      await client.exec("UPDATE designs SET status = 'approved' WHERE id = 77");
      await client.exec("UPDATE designs SET status = 'published' WHERE id = 79");
      const vision = { name: "test", writeListing: vi.fn(), assessImage: vi.fn(async () => ({
        score: 8, defects: [], notes: ["Balanced composition"], text: false, empty: false, frameOnly: false, artifacts: false,
      })) };
      const ids = [73, 74, 75, 76, 77, 78, 79, 80];
      const before = await db.select().from(designs);
      expect(await reassessDesigns(db, ids, vision, { apply: true })).toEqual([]);
      expect(vision.assessImage).not.toHaveBeenCalled();
      const preview = await reassessDesigns(db, ids, vision, { rescore: true });
      expect(preview.map((row) => row.id).sort()).toEqual([73, 74, 75]);
      expect(preview.every((row) => row.score === 8 && row.status === "generated" && row.reasons.length === 0)).toBe(true);
      expect(await db.select().from(designs)).toEqual(before);
      await reassessDesigns(db, ids, vision, { apply: true, rescore: true });
      const after = await db.select().from(designs);
      expect(after.filter((row) => row.id <= 75).every((row) => row.qualityScore === 8 && row.qualityReasons.length === 0 && row.status === "generated")).toBe(true);
      expect(after.filter((row) => row.id >= 76)).toEqual(before.filter((row) => row.id >= 76));
      expect(await db.select().from(listings)).toEqual([]);
      vision.assessImage.mockImplementationOnce(async () => {
        await client.exec("UPDATE designs SET status = 'listed' WHERE id = 73");
        return { score: 7, defects: [], notes: [], text: false, empty: false, frameOnly: false, artifacts: false };
      });
      await reassessDesigns(db, [73], vision, { apply: true, rescore: true });
      expect((await db.select().from(designs)).find((row) => row.id === 73)).toMatchObject({ status: "listed", qualityScore: 8 });
    } finally { await client.close(); }
  });

  it("surfaces sanitized vision errors in logs and stored reasons", async () => {
    const client = new PGlite("memory://");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("OLLAMA_API_KEY", "test-private-credential");
    try {
      const db = drizzle(client, { schema }) as DB;
      await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
      const image = `data:image/png;base64,${rgbPng(12, 18, [25, 25, 25]).toString("base64")}`;
      const [design] = await db.insert(designs).values({ niche: "alpine", prompt: "old", provider: "test", imageUrl: image, status: "rejected" }).returning();
      const vision = { name: "test", writeListing: vi.fn(), assessImage: vi.fn(async () => {
        throw new Error("Vision LLM returned an invalid assessment test-private-credential https://llm.example/?token=private-url-value");
      }) };
      const report = await reassessDesigns(db, [design.id], vision, { apply: true });
      expect(report[0]).toMatchObject({ status: "needs_review", reasons: ["Vision assessment unavailable: Vision LLM returned an invalid assessment [redacted] [URL redacted]"] });
      expect(log).toHaveBeenCalledWith(`Design #${design.id}: ${report[0].reasons[0]}`);
      expect((await db.select().from(designs))[0]).toMatchObject({ qualityScore: null, qualityReasons: report[0].reasons, status: "needs_review" });
    } finally { await client.close(); }
  });

  it("masks credentials, image data, and line breaks without logging error objects", () => {
    const message = 'Failed\napi_key="private value" ' + "Bearer " + "private-token sk-privatekey data:image/png;base64,privateimage https://" + ["user", "pass"].join(":") + "@host/path";
    const safe = sanitizeReassessmentError(new Error(message));
    for (const secret of ["private value", "private-token", "sk-privatekey", "privateimage", "@host", "\n"]) expect(safe).not.toContain(secret);
    expect(safe).toContain("[credential redacted]");
    expect(safe).toContain("[image data redacted]");
    expect(safe).toContain("[URL redacted]");
    expect(sanitizeReassessmentError(new Error("Database unavailable postgres://" + ["user", "pass"].join(":") + "@host/db"))).toBe("Database unavailable [URL redacted]");
    expect(sanitizeReassessmentError({ token: "private" })).toBe("Unknown error");
    expect(sanitizeReassessmentError(new Error("x".repeat(400)))).toHaveLength(300);
  });

  it("withholds database query parameters and masks persisted camelCase credentials", () => {
    const credentials = JSON.stringify({ accessToken: "private-access", refreshToken: "private-refresh", clientSecret: "private-secret" });
    const safe = sanitizeReassessmentError(new Error(credentials));
    for (const value of ["private-access", "private-refresh", "private-secret"]) expect(safe).not.toContain(value);
    expect(sanitizeReassessmentError(new Error(`Failed query: INSERT INTO settings VALUES ('${credentials}')\nparams: private-access`))).toBe(
      "Database query failed; query details withheld",
    );
    expect(sanitizeReassessmentError(Object.assign(new Error("params: private-access"), { query: "INSERT INTO settings" }))).toBe(
      "Database query failed; query details withheld",
    );
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
      await reassessDesigns(db, ids, vision, { apply: true });
      expect((await db.select().from(designs)).every((row) => row.status === "generated" && row.qualityScore === 8 && row.qualityReasons.length === 0)).toBe(true);
      expect(await reassessDesigns(db, ids, vision, { apply: true })).toEqual([]);
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
