import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";

const h = vi.hoisted(() => ({ db: null as unknown, bytes: null as Buffer | null, deleted: [] as string[] }));
vi.mock("@/db", () => ({ getDb: async () => h.db }));
vi.mock("@/lib/object-storage", async (orig) => ({
  ...(await orig<typeof import("@/lib/object-storage")>()),
  readStoredObject: vi.fn(async () => h.bytes ? { bytes: new Uint8Array(h.bytes), contentType: "image/png" } : null),
  storedUrlForKey: vi.fn(async (key: string) => `https://app/api/media/${key}`),
  deleteStoredObject: vi.fn(async (key: string) => { h.deleted.push(key); return true; }),
}));
vi.mock("@/db/upscale-designs", () => ({ upscaleDesigns: vi.fn(async () => ({})) }));
vi.mock("@/lib/upscale-jobs", async (orig) => ({
  ...(await orig<typeof import("@/lib/upscale-jobs")>()),
  authorizedUpscaleJob: () => true,
  requiredUpscaleTarget: async () => ({ minW: 200, minH: 250, targetW: 200, targetH: 250 }),
  attachA3Crop: vi.fn(async () => null),
  clearRedesignFlag: vi.fn(async () => false),
}));

async function freshDb() {
  const db = drizzle(new PGlite("memory://"), { schema }) as unknown as DB;
  await migrate(db as never, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  h.db = db;
  return db;
}
const KEY = "designs/2026-10-20/00000000-0000-4000-8000-0000000000aa.png";
const complete = async (designId: number, key = KEY) => {
  const { POST } = await import("@/app/api/cron/upscale-jobs/complete/route");
  return POST(new Request(`https://app/x?designId=${designId}&method=realesrgan&srcW=1&srcH=1&key=${key}`, { method: "POST" }));
};
const png = (w: number, hgt: number) => sharp({ create: { width: w, height: hgt, channels: 3, background: "#222" } }).png().toBuffer();

describe("upload hardening", () => {
  it("(d) complete only accepts a key bound to that design, once", async () => {
    const db = await freshDb();
    const [a] = await db.insert(schema.designs).values({ niche: "alpine", prompt: "p", provider: "cloudflare", imageUrl: "https://e/a.png" }).returning();
    const [b] = await db.insert(schema.designs).values({ niche: "alpine", prompt: "p", provider: "cloudflare", imageUrl: "https://e/b.png" }).returning();
    const { bindUploadKey } = await import("@/lib/upscale-failures");
    await bindUploadKey(db, KEY, a.id);
    h.bytes = await png(200, 250);
    expect((await complete(b.id)).status).toBe(403);
    expect((await complete(a.id)).status).toBe(200);
    expect((await complete(a.id)).status).toBe(403);
  });

  it("(c) a rejected upload is deleted from S3", async () => {
    const db = await freshDb();
    const [a] = await db.insert(schema.designs).values({ niche: "alpine", prompt: "p", provider: "cloudflare", imageUrl: "https://e/a.png" }).returning();
    const { bindUploadKey } = await import("@/lib/upscale-failures");
    await bindUploadKey(db, KEY, a.id);
    h.bytes = await png(100, 100);
    h.deleted = [];
    expect((await complete(a.id)).status).toBe(422);
    expect(h.deleted).toEqual([KEY]);
  });

  it("(b) 3 failures mark the design failed, drop it from the job list and list it for the dashboard", async () => {
    const db = await freshDb();
    const [a] = await db.insert(schema.designs).values({ niche: "alpine", prompt: "p", provider: "cloudflare", imageUrl: "https://e/a.png",
      needsRedesign: { reason: "x", sourcePx: { width: 1024, height: 1280 }, target: { minW: 1, minH: 1, targetW: 1, targetH: 1 }, presets: [], scale: 4, at: "now" } }).returning();
    const { recordUpscaleFailure, failedUpscaleJobs } = await import("@/lib/upscale-failures");
    const { pendingUpscaleJobs } = await import("@/lib/upscale-jobs");
    await recordUpscaleFailure(db, a.id, "HTTP 500");
    await recordUpscaleFailure(db, a.id, "HTTP 500");
    expect(await failedUpscaleJobs(db)).toEqual([]);
    const third = await recordUpscaleFailure(db, a.id, "HTTP 500");
    expect(third).toMatchObject({ attempts: 3, failed: true });
    expect((await failedUpscaleJobs(db)).map((r) => r.id)).toEqual([a.id]);
    expect((await pendingUpscaleJobs(db, 5)).map((j) => j.designId)).not.toContain(a.id);
    const [row] = await db.select().from(schema.designs).where(eq(schema.designs.id, a.id));
    expect(row.upscaleFailure?.failed).toBe(true);
  });
});

describe("(a) worker never falls back to a body upload", () => {
  it("throws when presign fails and sends no image body anywhere", async () => {
    process.env.UPSCALER_SECRET = "x".repeat(20);
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.body) bodies.push(String(url));
      return new Response("{}", { status: 503 });
    }) as unknown as typeof fetch;
    const { report } = await import("../workers/upscaler/pull");
    await expect(report(130, { width: 1024, height: 1280 }, Buffer.alloc(1024), fetchImpl)).rejects.toThrow(/presign failed HTTP 503/);
    expect(bodies).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
