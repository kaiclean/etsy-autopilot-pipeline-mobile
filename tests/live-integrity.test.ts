import path from "node:path";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setImageProviderForTests } from "@/adapters/image";
import { getLLMProvider } from "@/adapters/llm";
import { parseListingJson } from "@/adapters/llm/openai";
import { ReplicateImageProvider } from "@/adapters/image/replicate";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { designs, jobRuns, keywords, listings, shops } from "@/db/schema";
import { loadArtworkImage, ownMediaKey, renderArtworkPreview } from "@/lib/artwork-source";
import { decodePng, encodeRgbPng, shrinkToLongEdge, type RgbImage } from "@/lib/png";
import { loadEtsyDemandSignals } from "@/pipeline/etsy-demand";
import { runStage } from "@/pipeline/runner";

const ENV_KEYS = ["DEMO_MODE", "LLM_PROVIDER", "OPENAI_API_KEY", "ETSY_DEMAND_SOURCE", "ETSY_INSIGHTS_CSV", "ETSY_INSIGHTS_PATH", "REPLICATE_API_TOKEN"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.unstubAllGlobals();
  setImageProviderForTests(null);
});

async function memoryDb() {
  const client = new PGlite("memory://");
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  return db as unknown as DB;
}

async function omnishopId(db: DB) {
  const [shop] = await db.select().from(shops).where(eq(shops.slug, "omnishop-ch"));
  if (!shop) throw new Error("omnishop missing");
  return shop.id;
}

function gradient(width: number, height: number): RgbImage {
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = (y * width + x) * 3;
      rgb[d] = Math.round((x / width) * 255);
      rgb[d + 1] = Math.round((y / height) * 255);
      rgb[d + 2] = 90;
    }
  }
  return { width, height, rgb };
}

describe("listing writer outside demo mode", () => {
  it("uses the template writer only for demo shops", () => {
    delete process.env.LLM_PROVIDER;
    expect(getLLMProvider({ demo: true }).name).toBe("mock-template");
    expect(() => getLLMProvider({ demo: false })).toThrow(/LLM_PROVIDER=openai/);
  });

  it("requires the API key even when LLM_PROVIDER=openai", () => {
    process.env.LLM_PROVIDER = "openai";
    delete process.env.OPENAI_API_KEY;
    expect(() => getLLMProvider({ demo: false })).toThrow(/OPENAI_API_KEY/);
    process.env.OPENAI_API_KEY = "sk-test";
    expect(getLLMProvider({ demo: false }).name).toBe("openai");
  });

  it("parses fenced JSON from OpenAI-compatible models and rejects empty content", () => {
    expect(parseListingJson('```json\n{"title":"Alpine Print","tags":["a"],"body":"b"}\n```')).toEqual({ title: "Alpine Print", tags: ["a"], body: "b" });
    expect(() => parseListingJson(undefined)).toThrow(/no message content/);
    expect(() => parseListingJson("sorry, I cannot")).toThrow(/not JSON/);
  });

  it("fails the listing stage for a live shop instead of drafting template copy", async () => {
    process.env.DEMO_MODE = "false";
    delete process.env.LLM_PROVIDER;
    const db = await memoryDb();
    const shopId = await omnishopId(db);
    await db.insert(designs).values({ shopId, niche: "alpine", prompt: "p", provider: "openai", imageUrl: "https://cdn.example.com/a.png", isDemo: false });
    const run = await runStage("listing", "manual", { db });
    expect(run.status).toBe("failed");
    expect(run.summary).toMatch(/LLM_PROVIDER=openai/);
    expect(await db.select().from(listings)).toHaveLength(0);
  });
});

describe("seeded demo rows stay out of live stages", () => {
  it("publish skips demo listings when demo mode is off", async () => {
    process.env.DEMO_MODE = "false";
    const db = await memoryDb();
    const shopId = await omnishopId(db);
    await db.insert(listings).values({
      shopId,
      niche: "alpine",
      productType: "pod",
      podProvider: "printify:posterA3",
      title: "Demo Alpine Poster",
      tags: ["alpine"],
      description: "demo",
      imageUrl: "/api/placeholder/1?niche=alpine",
      priceChf: 30,
      netChf: 10,
      marginPct: 30,
      status: "approved",
      isDemo: true,
    });
    const run = await runStage("publish", "manual", { db });
    expect(run.summary).toBe("Nothing approved to publish.");
    const [row] = await db.select().from(listings);
    expect(row.status).toBe("approved");
  });

  it("design ignores demo keywords when demo mode is off", async () => {
    process.env.DEMO_MODE = "false";
    const db = await memoryDb();
    const shopId = await omnishopId(db);
    await db.insert(keywords).values({ shopId, phrase: "demo alpine ridge", niche: "alpine", source: "seed", score: 90, status: "selected", isDemo: true });
    const generate = vi.fn();
    setImageProviderForTests({ name: "stub", estimatedCostChf: 0.05, generate });
    const run = await runStage("design", "manual", { db });
    expect(run.summary).toMatch(/No keywords to design for/);
    const [runRow] = await db.select().from(jobRuns).where(eq(jobRuns.id, run.id));
    expect(runRow.isDemo).toBe(false);
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("Etsy demand fixture", () => {
  it("is read in demo mode only", async () => {
    delete process.env.ETSY_INSIGHTS_CSV;
    delete process.env.ETSY_INSIGHTS_PATH;
    process.env.ETSY_DEMAND_SOURCE = "fixture";
    expect((await loadEtsyDemandSignals({ demo: true })).length).toBeGreaterThan(0);
    expect(await loadEtsyDemandSignals({ demo: false })).toEqual([]);
    expect(await loadEtsyDemandSignals()).toEqual([]);
  });
});

describe("digital gallery preview", () => {
  it("renders the real artwork downscaled, never the flat niche card", async () => {
    const art = encodeRgbPng(gradient(1024, 1536));
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array(art), { status: 200 })) as unknown as typeof fetch;
    const png = await renderArtworkPreview(`/api/preview?niche=alpine&src=${encodeURIComponent("https://cdn.example.com/art.png")}`, fetchImpl);
    expect(png).not.toBeNull();
    const image = decodePng(png!)!;
    expect(Math.max(image.width, image.height)).toBeLessThanOrEqual(1200);
    expect(image.width / image.height).toBeCloseTo(1024 / 1536, 2);
    // Top-left is dark red/green, bottom-right is bright: the gradient survived.
    expect(image.rgb[0]).toBeLessThan(20);
    const last = (image.width * image.height - 1) * 3;
    expect(image.rgb[last]).toBeGreaterThan(230);
  });

  it("returns null for placeholder art, missing src, and private hosts", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(await renderArtworkPreview("/api/preview?niche=alpine", fetchImpl)).toBeNull();
    expect(await renderArtworkPreview(`/api/preview?src=${encodeURIComponent("/api/placeholder/3?niche=alpine")}`, fetchImpl)).toBeNull();
    expect(await loadArtworkImage("http://169.254.169.254/latest", fetchImpl)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("decodes inline data URLs and recognizes own media keys", async () => {
    const art = encodeRgbPng(gradient(40, 60));
    const image = await loadArtworkImage(`data:image/png;base64,${art.toString("base64")}`);
    expect(image?.width).toBe(40);
    expect(ownMediaKey("http://localhost:4317/api/media/designs/2026-10-10/0f8fad5b-d9cb-469f-a165-70867728950e.png")).toBe(
      "designs/2026-10-10/0f8fad5b-d9cb-469f-a165-70867728950e.png",
    );
    expect(ownMediaKey("https://x.example/api/media/../../etc/passwd")).toBeNull();
  });

  it("box-shrinks without changing aspect ratio", () => {
    const small = shrinkToLongEdge(gradient(300, 200), 150);
    expect([small.width, small.height]).toEqual([150, 100]);
    const same = gradient(50, 50);
    expect(shrinkToLongEdge(same, 100)).toBe(same);
  });
});

describe("Replicate adapter", () => {
  it("requests PNG output and polls a prediction that is still processing", async () => {
    process.env.REPLICATE_API_TOKEN = "r8_test";
    const calls: { url: string; body?: string }[] = [];
    const responses = [
      { status: "processing", urls: { get: "https://api.replicate.com/v1/predictions/abc" } },
      { status: "processing", urls: { get: "https://api.replicate.com/v1/predictions/abc" } },
      { status: "succeeded", output: ["https://replicate.delivery/out.png"] },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
        return new Response(JSON.stringify(responses.shift()), { status: 201 });
      }),
    );
    const img = await new ReplicateImageProvider({ pollMs: 1 }).generate({ prompt: "alpine", niche: "alpine", seed: 1 });
    expect(img.url).toBe("https://replicate.delivery/out.png");
    expect(JSON.parse(calls[0].body!).input.output_format).toBe("png");
    expect(calls.slice(1).every((c) => c.url === "https://api.replicate.com/v1/predictions/abc")).toBe(true);
  });

  it("reports a failed prediction with its error", async () => {
    process.env.REPLICATE_API_TOKEN = "r8_test";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: "failed", error: "NSFW content detected" }), { status: 201 })));
    await expect(new ReplicateImageProvider({ pollMs: 1 }).generate({ prompt: "x", niche: "alpine", seed: 1 })).rejects.toThrow(/status failed\): NSFW/);
  });
});
