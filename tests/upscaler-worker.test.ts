import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleUpscaleJob, TILE_LADDER } from "../workers/upscaler/job";
import { mediaUrlForKey } from "../workers/upscaler/media";
import { upscaleArtwork, upscaleViaWorker } from "@/pipeline/upscale";

const target = { minW: 100, minH: 100, targetW: 200, targetH: 200 };
const okResult = { url: "/api/media/designs/2026-10-20/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png", upscaleMethod: "realesrgan" as const, sourcePx: { width: 50, height: 50 }, outputPx: { width: 200, height: 200 } };

afterEach(() => vi.unstubAllEnvs());

describe("upscaler worker", () => {
  it("maps S3 keys to media sources", () => {
    expect(mediaUrlForKey("s3:designs/2026-10-20/x.png")).toBe("/api/media/designs/2026-10-20/x.png");
    expect(mediaUrlForKey("https://cdn.example/a.png")).toBe("https://cdn.example/a.png");
  });

  it("validates jobs and reports the stored key, time and memory", async () => {
    await expect(handleUpscaleJob({ source: "x" })).rejects.toThrow(/target/);
    const run = vi.fn(async () => okResult);
    const result = await handleUpscaleJob({ source: "s3:designs/a.png", target }, run as never);
    expect(result.key).toBe("designs/2026-10-20/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png");
    expect(result.tileSize).toBe(256);
    expect(result.peakRssMb).toBeGreaterThan(0);
  });

  it("retries smaller tiles when memory runs short, but not for other errors", async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error("Failed to allocate memory")).mockResolvedValue(okResult);
    expect((await handleUpscaleJob({ source: "https://a.example/x.png", target }, run)).tileSize).toBe(TILE_LADDER[1]);
    const bad = vi.fn().mockRejectedValue(new Error("Unable to read source artwork"));
    await expect(handleUpscaleJob({ source: "https://a.example/x.png", target }, bad)).rejects.toThrow(/read source/);
    expect(bad).toHaveBeenCalledTimes(1);
  });
});

describe("main app delegation", () => {
  it("posts to the worker with the secret and validates the reply", async () => {
    vi.stubEnv("UPSCALER_URL", "http://upscaler.railway.internal:8080/");
    vi.stubEnv("UPSCALER_SECRET", "s".repeat(32));
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(okResult))) as unknown as typeof fetch;
    expect(await upscaleViaWorker("https://a.example/x.png", target, {}, fetchImpl)).toEqual(okResult);
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(url).toBe("http://upscaler.railway.internal:8080/upscale");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${"s".repeat(32)}`);
    const broken = vi.fn(async () => new Response(JSON.stringify({ url: "" }))) as unknown as typeof fetch;
    await expect(upscaleViaWorker("x", target, {}, broken)).rejects.toThrow(/invalid/);
  });

  it("falls back to the local path when the worker is down", async () => {
    vi.stubEnv("UPSCALER_URL", "http://127.0.0.1:9");
    vi.stubEnv("UPSCALER_SECRET", "s".repeat(32));
    vi.stubEnv("REALESRGAN_MODEL_URL", "off");
    const png = await sharp({ create: { width: 60, height: 60, channels: 3, background: "#468" } }).png().toBuffer();
    const result = await upscaleArtwork(`data:image/png;base64,${png.toString("base64")}`, target);
    expect(result.upscaleMethod).toBe("lanczos");
    expect(result.outputPx).toEqual({ width: 200, height: 200 });
  });
});

import { inWindow } from "../workers/upscaler/pull";
import { authorizedUpscaleJob } from "@/lib/upscale-jobs";

describe("box pull model", () => {
  it("runs 03:00–10:30 UTC", () => {
    expect(inWindow(new Date("2026-10-20T03:00:00Z"))).toBe(true);
    expect(inWindow(new Date("2026-10-20T10:30:00Z"))).toBe(true);
    expect(inWindow(new Date("2026-10-20T10:31:00Z"))).toBe(false);
    expect(inWindow(new Date("2026-10-20T02:59:00Z"))).toBe(false);
  });

  it("accepts CRON_SECRET or UPSCALER_SECRET only", () => {
    vi.stubEnv("CRON_SECRET", "c".repeat(32));
    vi.stubEnv("UPSCALER_SECRET", "u".repeat(32));
    const req = (auth?: string) => new Request("http://x/api/cron/upscale-jobs", { headers: auth ? { authorization: auth } : {} });
    expect(authorizedUpscaleJob(req(`Bearer ${"c".repeat(32)}`))).toBe(true);
    expect(authorizedUpscaleJob(req(`Bearer ${"u".repeat(32)}`))).toBe(true);
    expect(authorizedUpscaleJob(req("Bearer nope"))).toBe(false);
    expect(authorizedUpscaleJob(req())).toBe(false);
  });
});

import { combineTargets, designPresets, reachableBy4x } from "@/lib/upscale-jobs";
describe("print targets per design", () => {
  it("lists every POD product of a shared design", () => {
    expect(designPresets(["printify:mug", "printify:posterA3", null, "printify:mug"], { productType: "pod", podPreset: "mug" })).toEqual(["posterA3"]);
    expect(designPresets([null], { productType: "digital", podPreset: null })).toEqual([]);
  });
  it("takes the max of each dimension", () => {
    expect(combineTargets([{ minW: 3508, minH: 4961, targetW: 3508, targetH: 4961 }, { minW: 4500, minH: 5400, targetW: 4500, targetH: 5400 }]))
      .toEqual({ minW: 4500, minH: 5400, targetW: 4500, targetH: 5400 });
  });
  it("sends sources a 4× pass cannot reach to Design", () => {
    expect(reachableBy4x({ width: 1024, height: 1024 }, { minW: 3508, minH: 4961, targetW: 3508, targetH: 4961 })).toEqual({ reachable: false, scale: 4.84 });
    expect(reachableBy4x({ width: 1024, height: 1536 }, { minW: 3508, minH: 4961, targetW: 3508, targetH: 4961 }).reachable).toBe(true);
  });
});
