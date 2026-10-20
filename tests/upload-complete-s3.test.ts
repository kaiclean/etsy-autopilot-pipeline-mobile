import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

const stored = vi.hoisted(() => ({ bytes: null as Buffer | null }));
vi.mock("@/lib/object-storage", async (orig) => ({
  ...(await orig<typeof import("@/lib/object-storage")>()),
  readStoredObject: vi.fn(async () => stored.bytes ? { bytes: new Uint8Array(stored.bytes), contentType: "image/png" } : null),
  storedUrlForKey: vi.fn(async (key: string) => `https://app/api/media/${key}`),
  uploadImageBytes: vi.fn(async () => { throw new Error("must not re-upload a presigned object"); }),
}));
vi.mock("@/db", () => ({ getDb: async () => ({ select: () => ({ from: () => ({ where: async () => [] }) }), update: () => ({ set: () => ({ where: () => Object.assign(Promise.resolve([]), { returning: async () => [{ key: "k" }] }) }) }) }) }));
vi.mock("@/db/upscale-designs", () => ({ upscaleDesigns: vi.fn(async () => ({})) }));
vi.mock("@/lib/upscale-jobs", () => ({
  authorizedUpscaleJob: () => true,
  requiredUpscaleTarget: async () => ({ minW: 100, minH: 120, targetW: 100, targetH: 120 }),
  attachA3Crop: vi.fn(async () => null),
  clearRedesignFlag: vi.fn(async () => true),
}));

describe("upload-complete with a presigned S3 key", () => {
  it("downloads the object and measures size + sha256 server-side, ignoring worker numbers", async () => {
    stored.bytes = await sharp({ create: { width: 128, height: 160, channels: 3, background: "#123" } }).png().toBuffer();
    const { POST } = await import("@/app/api/cron/upscale-jobs/complete/route");
    const key = "designs/2026-10-20/00000000-0000-4000-8000-000000000000.png";
    const res = await POST(new Request(`https://app/api/cron/upscale-jobs/complete?designId=130&method=realesrgan&srcW=32&srcH=40&key=${key}&outW=9999&outH=9999`, { method: "POST" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.outputPx).toEqual({ width: 128, height: 160 });
    expect(body.sha256).toBe(createHash("sha256").update(stored.bytes).digest("hex"));
    expect(body.bytes).toBe(stored.bytes.length);
    expect(body.key).toBe(key);
  });
  it("rejects an unknown key", async () => {
    stored.bytes = null;
    const { POST } = await import("@/app/api/cron/upscale-jobs/complete/route");
    const res = await POST(new Request("https://app/api/cron/upscale-jobs/complete?designId=130&method=realesrgan&srcW=1&srcH=1&key=designs/2026-10-20/00000000-0000-4000-8000-000000000001.png", { method: "POST" }));
    expect(res.status).toBe(404);
  });
});

describe("worker report()", () => {
  it("PUTs to the presigned URL and completes with only the key (no image body)", async () => {
    process.env.UPSCALER_SECRET = "x".repeat(20);
    const calls: { url: string; method?: string; hasBody: boolean }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method, hasBody: init?.body != null });
      if (String(url).includes("/upload-url?designId=130")) return new Response(JSON.stringify({ key: "designs/2026-10-20/k.png", putUrl: "https://s3/put" }));
      if (String(url) === "https://s3/put") return new Response(null, { status: 200 });
      return new Response(JSON.stringify({ ok: true }));
    }) as unknown as typeof fetch;
    const { report } = await import("../workers/upscaler/pull");
    const out = await report(130, { width: 1024, height: 1280 }, Buffer.alloc(11 * 1024 * 1024), fetchImpl);
    expect(out.status).toBe(200);
    expect(calls[1]).toMatchObject({ url: "https://s3/put", method: "PUT", hasBody: true });
    expect(calls[2].url).toContain("key=designs");
    expect(calls[2].hasBody).toBe(false);
  });
});
