import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareImageProvider, CLOUDFLARE_IMAGE_MODEL } from "@/adapters/image/cloudflare";
import { getImageProvider } from "@/adapters/image";
import { RunPodImageProvider } from "@/adapters/image/runpod";
import { withStoredUrl } from "@/lib/object-storage";
import { config, integrationStatus } from "@/lib/config";
import { connectionHealth } from "@/lib/health";
import { probeConnections } from "@/lib/provider-probe";

vi.mock("@/lib/object-storage", () => ({
  withStoredUrl: vi.fn(async (image) => ({ ...image, url: "https://storage.example/art.jpg" })),
}));

const request = { prompt: "alpine landscape", niche: "alpine" as const, seed: 7, aspectRatio: "2:3" as const };
const generated = { url: "https://storage.example/art.jpg", costChf: 0, provider: "cloudflare" };

beforeEach(() => {
  vi.stubEnv("IMAGE_PROVIDER", "cloudflare");
  vi.stubEnv("IMAGE_FALLBACK_PROVIDER", "");
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "account");
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "test-cloudflare-token");
  vi.stubEnv("LLM_PROVIDER", "mock");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Cloudflare images", () => {
  it("selects Cloudflare and materializes its base64 JPEG using the documented API", async () => {
    const fetchMock = vi.fn(async () => Response.json({ success: true, result: { image: "anBlZw==" } }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = getImageProvider();
    expect(provider.name).toBe("cloudflare");
    expect(provider.estimatedCostChf).toBe(0);
    await expect(provider.generate(request)).resolves.toEqual(generated);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.cloudflare.com/client/v4/accounts/account/ai/run/${CLOUDFLARE_IMAGE_MODEL}`,
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer " + "test-cloudflare-token", "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: request.prompt, steps: 4 }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(withStoredUrl).toHaveBeenCalledWith({ url: "data:image/jpeg;base64,anBlZw==", costChf: 0, provider: "cloudflare" });
  });

  it.each(["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"])("requires %s before making a request", async (key) => {
    vi.stubEnv(key, "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(new CloudflareImageProvider().generate(request)).rejects.toThrow(`${key} missing`);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { success: true, result: {} },
    { success: true, result: { image: "https://unsafe.example/image" } },
    { success: false, errors: [{ message: "quota exhausted" }] },
  ])("rejects missing/invalid images and API-level failures", async (body) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(body)));
    await expect(new CloudflareImageProvider().generate(request)).rejects.toThrow(/Cloudflare/);
    expect(withStoredUrl).not.toHaveBeenCalled();
  });

  it("reports real HTTP errors without exposing credentials", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("quota exhausted test-cloudflare-token", { status: 429 })));
    await expect(new CloudflareImageProvider().generate(request)).rejects.toThrow("Cloudflare HTTP 429: quota exhausted [redacted]");
  });

  it("bounds a stalled response body and reports the timeout clearly", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), ms);
      return controller.signal;
    });
    vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => ({
      ok: true,
      json: () => new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason))),
    })));
    try {
      const pending = expect(new CloudflareImageProvider().generate(request)).rejects.toThrow("timed out after 30 seconds");
      await vi.advanceTimersByTimeAsync(30_000);
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports missing credentials and readiness on the dashboard without showing tokens", () => {
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
    expect(integrationStatus(false).find((item) => item.id === "images")?.status).toBe("missing");
    expect(connectionHealth({ etsyConnected: false }).find((item) => item.id === "images")?.level).toBe("red");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "test-cloudflare-token");
    expect(integrationStatus(false).find((item) => item.id === "images")?.status).toBe("configured");
    const health = connectionHealth({ etsyConnected: false }).find((item) => item.id === "images");
    expect(health?.level).toBe("green");
    expect(health?.detail).not.toContain("test-cloudflare-token");
  });

  it("includes Cloudflare in Test connection and preserves HTTP classification", async () => {
    const fetchMock = vi.fn(async () => Response.json({ success: true, result: { image: "anBlZw==" } }));
    vi.stubGlobal("fetch", fetchMock);
    expect((await probeConnections()).image).toMatchObject({ status: "ok", httpStatus: 200 });
    fetchMock.mockImplementation(async () => new Response("unauthorized", { status: 401 }));
    expect((await probeConnections()).image).toMatchObject({ status: "401", httpStatus: 401 });
  });
});

describe("opt-in image fallback", () => {
  it("keeps the existing default and does not enable fallback implicitly", async () => {
    vi.stubEnv("IMAGE_PROVIDER", "");
    expect(config.imageProvider).toBe("mock");
    expect(getImageProvider({ demo: true }).name).toBe("mock");
    expect(() => getImageProvider()).toThrow("Mock artwork");
    vi.stubEnv("IMAGE_PROVIDER", "runpod");
    const primary = vi.spyOn(RunPodImageProvider.prototype, "generate").mockRejectedValue(new Error("RunPod HTTP 409: no workers"));
    const fallback = vi.spyOn(CloudflareImageProvider.prototype, "generate");
    await expect(getImageProvider().generate(request)).rejects.toThrow("409: no workers");
    expect(primary).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();
  });

  it("logs primary failure to activity and server logs, tries fallback once, and reserves both costs", async () => {
    vi.stubEnv("IMAGE_PROVIDER", "runpod");
    vi.stubEnv("IMAGE_FALLBACK_PROVIDER", "cloudflare");
    vi.stubEnv("RUNPOD_COST_PER_IMAGE_CHF", "0.05");
    vi.spyOn(RunPodImageProvider.prototype, "generate").mockRejectedValue(new Error("RunPod HTTP 409: no workers test-cloudflare-token"));
    const fallback = vi.spyOn(CloudflareImageProvider.prototype, "generate").mockResolvedValue(generated);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.fn();
    const provider = getImageProvider({ log });
    expect(provider.estimatedCostChf).toBe(0.05);
    await expect(provider.generate(request)).resolves.toEqual({ ...generated, costChf: 0.05 });
    expect(fallback).toHaveBeenCalledExactlyOnceWith(request);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("RunPod HTTP 409: no workers [redacted]"), "warn");
    expect(warn).toHaveBeenCalledWith(log.mock.calls[0][0]);
  });

  it("does not call fallback after primary success", async () => {
    vi.stubEnv("IMAGE_FALLBACK_PROVIDER", "runpod");
    vi.spyOn(CloudflareImageProvider.prototype, "generate").mockResolvedValue(generated);
    const fallback = vi.spyOn(RunPodImageProvider.prototype, "generate");
    await expect(getImageProvider().generate(request)).resolves.toEqual(generated);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("retains both failures without recursive retries", async () => {
    vi.stubEnv("IMAGE_FALLBACK_PROVIDER", "runpod");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const primary = vi.spyOn(CloudflareImageProvider.prototype, "generate").mockRejectedValue(new Error("quota exhausted"));
    const fallback = vi.spyOn(RunPodImageProvider.prototype, "generate").mockRejectedValue(new Error("no workers"));
    await expect(getImageProvider().generate(request)).rejects.toThrow("cloudflare failed: quota exhausted; fallback runpod failed: no workers");
    expect(primary).toHaveBeenCalledOnce();
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("ignores an identical fallback and rejects mock or unknown fallbacks", () => {
    vi.stubEnv("IMAGE_FALLBACK_PROVIDER", "cloudflare");
    expect(getImageProvider()).toBeInstanceOf(CloudflareImageProvider);
    vi.stubEnv("IMAGE_FALLBACK_PROVIDER", "mock");
    expect(() => getImageProvider()).toThrow("not mock");
    vi.stubEnv("IMAGE_FALLBACK_PROVIDER", "typo");
    expect(() => getImageProvider()).toThrow("IMAGE_FALLBACK_PROVIDER");
  });

  it("does not mask primary failure in Test connection", async () => {
    vi.stubEnv("IMAGE_FALLBACK_PROVIDER", "runpod");
    vi.spyOn(CloudflareImageProvider.prototype, "generate").mockRejectedValue(new Error("quota exhausted"));
    const fallback = vi.spyOn(RunPodImageProvider.prototype, "generate");
    expect((await probeConnections()).image).toMatchObject({ status: "error", detail: "quota exhausted" });
    expect(fallback).not.toHaveBeenCalled();
  });
});
