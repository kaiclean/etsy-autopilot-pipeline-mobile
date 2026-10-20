import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { blankEdgeBands, trimBlankEdges } from "@/lib/edge-check";
import { finalPng } from "@/pipeline/upscale";

async function noise(w: number, h: number) {
  const raw = Buffer.alloc(w * h * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) % 251;
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}
async function withBands(w: number, h: number, top: number, left: number) {
  const art = await noise(w - left, h - top);
  return sharp({ create: { width: w, height: h, channels: 3, background: "#fefefe" } }).composite([{ input: art, left, top }]).png().toBuffer();
}

describe("blank-edge check", () => {
  it("detects bands on top and left (all four sides scanned)", async () => {
    const b = await blankEdgeBands(await withBands(200, 250, 19, 17));
    expect(b).toMatchObject({ top: 19, left: 17, bottom: 0, right: 0, blank: true });
  });
  it("clean art has no bands", async () => {
    expect((await blankEdgeBands(await noise(200, 250))).blank).toBe(false);
  });
  it("trims and re-checks the size floor: rejects when trimmed art is too small", async () => {
    const bytes = await withBands(1024, 1280, 18, 16);
    const out = await trimBlankEdges(bytes, { width: 1024, height: 1280 });
    expect(out.ok).toBe(false);
    const ok = await trimBlankEdges(bytes, { width: 1000, height: 1200 });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(await sharp(ok.bytes).metadata()).toMatchObject({ width: 1008, height: 1262 });
  });
});

describe("finalPng truecolor", () => {
  it("writes a non-palette PNG with more than 256 colours", async () => {
    const out = await finalPng(await noise(64, 80), { minW: 128, minH: 160, targetW: 128, targetH: 160 });
    const meta = await sharp(out).metadata();
    expect(meta.isPalette ?? false).toBe(false);
    expect(meta.channels).toBeGreaterThanOrEqual(3);
    const { data } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    const colours = new Set<number>();
    for (let i = 0; i < data.length; i += 3) colours.add((data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!);
    expect(colours.size).toBeGreaterThan(256);
  });
});

describe("design review gate", () => {
  it("upload keeps the flag and sets review pending; only Design approve clears it", async () => {
    const db = drizzle(new PGlite("memory://"), { schema }) as unknown as DB;
    await migrate(db as never, { migrationsFolder: path.join(process.cwd(), "drizzle") });
    const flag = { reason: "x", sourcePx: { width: 1024, height: 1280 }, target: { minW: 4016, minH: 5057, targetW: 4016, targetH: 5057 }, presets: [], scale: 4, at: "now" };
    const [d] = await db.insert(schema.designs).values({ niche: "alpine", prompt: "p", provider: "cloudflare", imageUrl: "https://e/a.png", needsRedesign: flag }).returning();
    const { clearRedesignFlag } = await import("@/lib/upscale-jobs");
    const { designReviewBlocker, signOffDesign } = await import("@/lib/design-review");
    expect(await clearRedesignFlag(db, d.id, { width: 4096, height: 5120 })).toBe(false);
    let [row] = await db.select().from(schema.designs).where(eq(schema.designs.id, d.id));
    expect(row.needsRedesign).not.toBeNull();
    expect(row.designReview?.status).toBe("pending");
    expect(await designReviewBlocker(db, d.id)).toMatch(/pending/);
    await signOffDesign(db, d.id, "reject", "mesh in sky");
    expect(await designReviewBlocker(db, d.id)).toMatch(/rejected/);
    await signOffDesign(db, d.id, "approve");
    [row] = await db.select().from(schema.designs).where(eq(schema.designs.id, d.id));
    expect(row.needsRedesign).toBeNull();
    expect(await designReviewBlocker(db, d.id)).toBeNull();
  });
});

describe("dark edges are never trimmed", () => {
  it("a night-sky render with a flat dark top band: no trim, flagged for review", async () => {
    const w = 200, h = 250;
    const raw = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const v = y < 20 ? 12 : 10 + ((x * 7 + y * 13) % 60); // flat night sky band, then dark textured scene
      raw[i] = v; raw[i + 1] = v; raw[i + 2] = v + 20;
    }
    const night = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
    const { flatEdgeBands } = await import("@/lib/edge-check");
    const bright = await blankEdgeBands(night);
    expect(bright.blank).toBe(false);
    const trim = await trimBlankEdges(night, { width: w, height: h });
    expect(trim.ok).toBe(true);
    if (trim.ok) expect(await sharp(trim.bytes).metadata()).toMatchObject({ width: w, height: h });
    const flat = await flatEdgeBands(night);
    expect(flat.review).toBe(true);
    expect(flat.top).toBe(20);
  });
});

describe("edge check is exact at full resolution", () => {
  it("finds a 1px and a 3px bright band on a 4096-wide master", async () => {
    const w = 4096, h = 512;
    const art = await noise(w - 3, h - 1);
    const img = await sharp({ create: { width: w, height: h, channels: 3, background: "#ffffff" } }).composite([{ input: art, left: 3, top: 1 }]).png().toBuffer();
    expect(await blankEdgeBands(img)).toMatchObject({ top: 1, left: 3, bottom: 0, right: 0 });
  });
  it("top/bottom bands are bounded by height, left/right by width (square and tall images)", async () => {
    const white = await sharp({ create: { width: 64, height: 200, channels: 3, background: "#ffffff" } }).png().toBuffer();
    const b = await blankEdgeBands(white);
    expect(b.top + b.bottom).toBeLessThanOrEqual(200);
    expect(b.left + b.right).toBeLessThanOrEqual(64);
    expect(b.trimmed.width).toBeGreaterThanOrEqual(0);
    expect(b.trimmed.height).toBeGreaterThanOrEqual(0);
  });
});

describe("despeckle on flat regions only", () => {
  it("removes isolated specks in a flat sky and leaves textured blocks unchanged", async () => {
    const { despeckleFlatRegions } = await import("@/lib/despeckle");
    const w = 128, h = 128;
    const raw = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const v = y < 64 ? 200 : (x * 37 + y * 91) % 256; // flat sky over textured ground
      raw[i] = v; raw[i + 1] = v; raw[i + 2] = v;
    }
    for (const [x, y] of [[10, 10], [40, 20], [90, 50]]) { const i = (y! * w + x!) * 3; raw[i] = raw[i + 1] = raw[i + 2] = 20; }
    const png = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
    const out = await despeckleFlatRegions(png, { block: 32 });
    expect(out.flatBlocks).toBe(8);
    const { data } = await sharp(out.bytes).raw().toBuffer({ resolveWithObject: true });
    for (const [x, y] of [[10, 10], [40, 20], [90, 50]]) expect(data[(y! * w + x!) * 3]).toBe(200);
    for (let y = 64; y < h; y++) for (let x = 0; x < w; x++) expect(data[(y * w + x) * 3]).toBe(raw[(y * w + x) * 3]);
  });
});
