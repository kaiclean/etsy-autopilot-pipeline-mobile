import { upscaleFixture } from "./helpers-upscale";
import { drainJobs } from "@/lib/durable-jobs";
import type { DB } from "@/db";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blankEdgeBands } from "@/lib/edge-check";

const h = vi.hoisted(() => ({ src: null as Buffer | null, uploaded: [] as Buffer[], a3: [] as { bytes: Buffer; size: unknown }[], deleted: [] as string[], updates: [] as unknown[] }));
vi.mock("@/lib/object-storage", async (orig) => ({
  ...(await orig<typeof import("@/lib/object-storage")>()),
  readStoredObject: vi.fn(async (key:string) => ({ bytes: new Uint8Array(key.includes("trimmed") ? h.uploaded[0] : h.src!), contentType: "image/png" })),
  storedUrlForKey: vi.fn(async (key: string) => `https://app/api/media/${key}`),
  uploadImageBytes: vi.fn(async (bytes: Buffer) => { h.uploaded.push(bytes); return { url: "https://app/trimmed.png", key: "designs/2026-10-20/trimmed.png", backend: "s3" }; }),
  deleteStoredObject: vi.fn(async (key: string) => { h.deleted.push(key); return true; }),
}));
vi.mock("@/lib/upscale-failures", () => ({ consumeUploadKey: async () => true }));
const fixture=vi.hoisted(()=>({db:null as unknown}));
vi.mock("@/db",()=>({getDb:async()=>fixture.db}));
vi.mock("@/db/upscale-designs", () => ({ upscaleDesigns: vi.fn(async () => ({})) }));
vi.mock("@/lib/upscale-jobs", () => ({
  authorizedUpscaleJob: () => true,
  requiredUpscaleTarget: async () => ({ minW: 150, minH: 200, targetW: 150, targetH: 200 }),
  attachA3Crop: vi.fn(async (_db: unknown, _id: number, bytes: Buffer, _url: string, size: unknown) => { h.a3.push({ bytes, size }); return null; }),
  clearRedesignFlag: vi.fn(async () => false),
}));

async function art(w: number, hgt: number, opts: { top?: number; left?: number; bg?: string; flatDark?: number } = {}) {
  const raw = Buffer.alloc(w * hgt * 3);
  for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3;
    const v = opts.flatDark && y < opts.flatDark ? 15 : 30 + ((x * 7 + y * 13) % 150);
    raw[i] = v; raw[i + 1] = (v * 3) % 256; raw[i + 2] = (v * 5) % 256;
  }
  const inner = await sharp(raw, { raw: { width: w, height: hgt, channels: 3 } }).png().toBuffer();
  if (!opts.top && !opts.left) return inner;
  const iw = w - (opts.left ?? 0), ih = hgt - (opts.top ?? 0);
  return sharp({ create: { width: w, height: hgt, channels: 3, background: "#fdfdfd" } })
    .composite([{ input: await sharp(inner).extract({ left: 0, top: 0, width: iw, height: ih }).toBuffer(), left: opts.left ?? 0, top: opts.top ?? 0 }]).png().toBuffer();
}
const call = async () => {
  const { POST } = await import("@/app/api/cron/upscale-jobs/complete/route");
  return POST(new Request("https://app/x?designId=7&method=realesrgan&srcW=50&srcH=62&key=designs/2026-10-20/00000000-0000-4000-8000-0000000000bb.png", { method: "POST" }));
};

describe("complete: edge check on every upload", () => {
  let close:()=>Promise<void>;
  beforeEach(async()=>{const f=await upscaleFixture(7,"designs/2026-10-20/00000000-0000-4000-8000-0000000000bb.png");fixture.db=f.db;close=()=>f.client.close();});
  afterEach(async()=>{await close();});
  it("bright bands are trimmed; the stored file and the A3 source have no band", async () => {
    h.src = await art(200, 250, { top: 12, left: 9 }); h.uploaded = []; h.a3 = []; h.deleted = [];
    const res = await call();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.outputPx).toEqual({ width: 191, height: 238 });
    expect(h.uploaded).toHaveLength(1);
    expect((await blankEdgeBands(h.uploaded[0]!)).blank).toBe(false);
    expect(await sharp(h.uploaded[0]!).metadata()).toMatchObject({ width: 191, height: 238 });
    await drainJobs(fixture.db as DB,1);
    expect(h.a3[0]!.bytes.equals(h.uploaded[0]!)).toBe(true);
    expect(h.deleted).toEqual(["designs/2026-10-20/00000000-0000-4000-8000-0000000000bb.png"]);
  });
  it("rejects when the trimmed file falls below the size floor", async () => {
    h.src = await art(200, 250, { top: 60 }); h.deleted = [];
    const res = await call();
    expect(res.status).toBe(422);
    expect(h.deleted).toHaveLength(1);
  });
  it("dark/flat bands are not cut: full size kept, design marked for review", async () => {
    h.src = await art(200, 250, { flatDark: 20 }); h.uploaded = []; h.updates = [];
    const res = await call();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.outputPx).toEqual({ width: 200, height: 250 });
    expect(body.edge.flat.review).toBe(true);
    expect(h.uploaded).toHaveLength(0);
    await drainJobs(fixture.db as DB,1);
    const rows=await (fixture.db as DB).select().from((await import("@/db/schema")).designs);
    expect(rows[0].designReview?.status).toBe("pending");
  });
  it("a clean upload passes untouched (unflagged designs are checked too)", async () => {
    h.src = await art(200, 250); h.uploaded = [];
    const body = await (await call()).json();
    expect(body.edge.bright.trimmed).toBe(false);
    expect(body.edge.flat.review).toBe(false);
    expect(h.uploaded).toHaveLength(0);
  });
});
