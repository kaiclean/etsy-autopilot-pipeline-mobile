import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_REALESRGAN_MODEL_SHA256, DEFAULT_REALESRGAN_MODEL_URL, config, integrationStatus } from "@/lib/config";
import { downloadModel, resolveModelSourceForTests } from "@/pipeline/upscale";
import { setUpscalerState } from "@/lib/upscaler-status";

const bytes = new TextEncoder().encode(`fake-onnx-${Math.random()}`);
const sha = createHash("sha256").update(bytes).digest("hex");

function fetchReturning(body: Uint8Array, headers: Record<string, string> = {}) {
  return vi.fn(async () => new Response(Buffer.from(body), { status: 200, headers })) as unknown as typeof fetch;
}

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(path.join(os.tmpdir(), `realesrgan-${sha}.onnx`), { force: true });
  setUpscalerState({ state: "idle" });
});

describe("Real-ESRGAN model from URL", () => {
  it("defaults to the pinned x4plus model and can be switched off", () => {
    expect(config.upscale.modelUrl).toBe(DEFAULT_REALESRGAN_MODEL_URL);
    expect(config.upscale.modelSha256).toBe(DEFAULT_REALESRGAN_MODEL_SHA256);
    vi.stubEnv("REALESRGAN_MODEL_URL", "off");
    expect(config.upscale.modelUrl).toBeUndefined();
  });

  it("downloads, verifies the hash and caches in tmp", async () => {
    const fetchImpl = fetchReturning(bytes);
    const file = await downloadModel("https://models.example/x4.onnx", sha, fetchImpl);
    expect(file).toBe(path.join(os.tmpdir(), `realesrgan-${sha}.onnx`));
    expect(existsSync(file!)).toBe(true);
    const again = await downloadModel("https://models.example/x4.onnx", sha, fetchImpl);
    expect(again).toBe(file);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses a hash mismatch", async () => {
    const wrong = "0".repeat(64);
    expect(await downloadModel("https://models.example/x4.onnx", wrong, fetchReturning(bytes))).toBeNull();
    expect(existsSync(path.join(os.tmpdir(), `realesrgan-${wrong}.onnx`))).toBe(false);
  });

  it("refuses oversize downloads and plain HTTP", async () => {
    const big = fetchReturning(bytes, { "content-length": String(300 * 1024 * 1024) });
    expect(await downloadModel("https://models.example/x4.onnx", sha, big)).toBeNull();
    const plain = fetchReturning(bytes);
    expect(await downloadModel("http://models.example/x4.onnx", sha, plain)).toBeNull();
    expect(plain).not.toHaveBeenCalled();
  });

  it("prefers REALESRGAN_MODEL_PATH over the URL", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "esr-"));
    const local = path.join(dir, "m.onnx");
    writeFileSync(local, bytes);
    vi.stubEnv("REALESRGAN_MODEL_PATH", local);
    const fetchImpl = fetchReturning(bytes);
    expect(await resolveModelSourceForTests(fetchImpl)).toEqual({ source: "path", model: local });
    expect(fetchImpl).not.toHaveBeenCalled();
    rmSync(dir, { recursive: true, force: true });
  });

  it("falls through to the URL and reports a reason when disabled", async () => {
    vi.stubEnv("REALESRGAN_MODEL_URL", "https://models.example/x4.onnx");
    vi.stubEnv("REALESRGAN_MODEL_SHA256", sha);
    expect((await resolveModelSourceForTests(fetchReturning(bytes))).source).toBe("url");
    vi.stubEnv("REALESRGAN_MODEL_URL", "off");
    expect(await resolveModelSourceForTests(fetchReturning(bytes))).toEqual({ source: null, reason: "no model source configured" });
  });

  it("shows upscaler state on the dashboard integrations", () => {
    setUpscalerState({ state: "ready", source: "url", loadMs: 2100, io: "input→output" });
    const row = integrationStatus(false).find((item) => item.id === "upscaler");
    expect(row?.status).toBe("connected");
    expect(row?.detail).toContain("loaded from url");
    setUpscalerState({ state: "fallback", reason: "model hash mismatch" });
    expect(integrationStatus(false).find((item) => item.id === "upscaler")?.detail).toContain("Lanczos fallback: model hash mismatch");
  });
});
