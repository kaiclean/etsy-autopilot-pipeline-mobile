import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { a3CropSize, clearRedesignFlag, pendingUpscaleJobs } from "@/lib/upscale-jobs";
import { cloudflareModelInput, CLOUDFLARE_PRINT_IMAGE_MODEL } from "@/adapters/image/cloudflare";

const png = vi.hoisted(() => ({ url: "" }));
vi.mock("@/adapters/image", () => ({
  getImageProvider: () => ({ name: "cloudflare", estimatedCostChf: 0, generate: vi.fn(async (req: { prompt: string; width: number; height: number; print: boolean }) => {
    expect(req).toMatchObject({ width: 1024, height: 1280, print: true, prompt: "own original prompt" });
    return { url: png.url, costChf: 0, provider: "cloudflare" };
  }) }),
}));

async function freshDb() {
  const client = new PGlite("memory://");
  const db = drizzle(client, { schema }) as unknown as DB;
  await migrate(db as never, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  return db;
}

describe("single-pass redesign", () => {
  it("A3 crop of the 4096×5120 master is 3620×5120", () => {
    expect(a3CropSize({ width: 4096, height: 5120 })).toEqual({ width: 3620, height: 5120 });
  });

  it("print model honours size; schnell does not", () => {
    const input = cloudflareModelInput(CLOUDFLARE_PRINT_IMAGE_MODEL, { prompt: "p", niche: "alpine", seed: 1, width: 1024, height: 1280 });
    const form = input.body as FormData;
    expect([form.get("width"), form.get("height")]).toEqual(["1024", "1280"]);
  });

  it("re-renders a flagged design from its own prompt, queues one native 4× pass, and clears the flag at target", async () => {
    const db = await freshDb();
    png.url = `data:image/png;base64,${(await sharp({ create: { width: 1024, height: 1280, channels: 3, background: "#456" } }).png().toBuffer()).toString("base64")}`;
    const target = { minW: 4016, minH: 5057, targetW: 4016, targetH: 5057 };
    const [d] = await db.insert(schema.designs).values({ niche: "alpine", prompt: "own original prompt", provider: "cloudflare", imageUrl: "https://e/old.png", imageWidth: 3510, imageHeight: 4950, upscaleMethod: "realesrgan",
      needsRedesign: { reason: "x", sourcePx: { width: 1024, height: 1024 }, target, presets: ["tshirt"], scale: 4.94, at: "now" } }).returning();
    await db.insert(schema.listings).values({ designId: d.id, niche: "alpine", productType: "pod", podProvider: "printify:tshirt", title: "t", tags: [], description: "d", imageUrl: "https://e/a.png", priceChf: 30, netChf: 9, marginPct: 30 });
    const { regenerateFlaggedDesign } = await import("@/lib/redesign");
    const result = await regenerateFlaggedDesign(db, d.id, () => {});
    expect([result.width, result.height]).toEqual([1024, 1280]);
    const jobs = await pendingUpscaleJobs(db, 5);
    expect(jobs.map((job) => job.designId)).toEqual([d.id]);
    expect(jobs[0]!.target).toMatchObject({ targetW: 4096, targetH: 5120 });
    expect(await clearRedesignFlag(db, d.id, { width: 4000, height: 5000 })).toBe(false);
    expect(await clearRedesignFlag(db, d.id, { width: 4096, height: 5120 })).toBe(true);
  });
});
