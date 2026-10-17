import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunPodImageProvider } from "@/adapters/image/runpod";
import { isSafeArtworkUrl } from "@/lib/art-quality";
import { preparePrintFile } from "@/pipeline/artwork";
import { rgbPng } from "@/lib/png";
import { materializeImageUrl } from "@/lib/object-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class { async send() {} },
  PutObjectCommand: class {},
  GetObjectCommand: class {},
}));
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: vi.fn(async () => "https://bucket.example/stored?X-Amz-Expires=604800") }));

const request = { prompt: "mountain poster", niche: "alpine" as const, seed: 1, print: true };
beforeEach(() => {
  vi.stubEnv("RUNPOD_API_KEY", "test");
  vi.stubEnv("RUNPOD_ENDPOINT_ID", "test");
  vi.stubEnv("RUNPOD_COMFY_WORKFLOW", JSON.stringify({
    "6": { class_type: "CLIPTextEncode", inputs: { text: "{{PROMPT}}" } },
    "9": { class_type: "SaveImage", inputs: { images: ["8", 0] } },
  }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("RunPod diagnostics", () => {
  it.each(["submit", "status"])("logs the real %s HTTP status and error body without secrets", async (phase) => {
    vi.stubEnv("RUNPOD_API_KEY", "private-runpod-token");
    const fetchMock = vi.fn();
    if (phase === "status") fetchMock.mockResolvedValueOnce(Response.json({ id: "job-1", status: "IN_QUEUE" }));
    fetchMock.mockResolvedValueOnce(Response.json({
      error: "No workers available",
      token: "private-runpod-token",
      detail: "private-runpod-token",
      url: "https://bucket.example/art?signature=private",
    }, { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = await new RunPodImageProvider({ pollMs: 0 }).generate(request).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toMatch(new RegExp(`RunPod ${phase}.*HTTP 409`));
    expect(message).toContain("No workers available");
    expect(message).not.toMatch(/private-runpod-token|signature=private|https:/);
    expect(log).toHaveBeenCalledWith(message);
  });

  it.each(["submit", "status"])("fails fast on %s timeout without retrying", async (phase) => {
    const fetchMock = vi.fn();
    if (phase === "status") fetchMock.mockResolvedValueOnce(Response.json({ id: "job-1", status: "IN_QUEUE" }));
    fetchMock.mockRejectedValueOnce(new DOMException("operation aborted", "TimeoutError"));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(new RunPodImageProvider({ pollMs: 0 }).generate(request)).rejects.toThrow(new RegExp(`RunPod ${phase}.*timed out.*check endpoint workers`));
    expect(fetchMock).toHaveBeenCalledTimes(phase === "submit" ? 1 : 2);
  });

  it("bounds queue polling by the overall deadline", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => Response.json({ id: "queued-job", status: "IN_QUEUE" }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const pending = expect(new RunPodImageProvider({ pollMs: 2_000, deadlineMs: 100 }).generate(request)).rejects.toThrow(/timed out after 0.1 seconds.*queued-job/);
      await vi.advanceTimersByTimeAsync(100);
      await pending;
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("RunPod output", () => {
  it("uses the stable media proxy even when app S3 storage normally returns signed URLs", async () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "test");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test");
    vi.stubEnv("AWS_ENDPOINT_URL_S3", "https://storage.example");
    vi.stubEnv("S3_BUCKET", "test");
    vi.stubEnv("S3_PUBLIC_BASE_URL", "");
    vi.stubEnv("S3_URL_MODE", "signed");
    vi.stubEnv("APP_URL", "https://app.example");
    const fetchImpl = vi.fn(async () => new Response("png", { headers: { "content-type": "image/png" } }));
    const stored = await materializeImageUrl("https://bucket.example/art?X-Amz-Signature=test", { requireStored: true, fetchImpl });
    expect(stored).toMatch(/^https:\/\/app.example\/api\/media\/designs\/.*\.png$/);
    expect(stored).not.toContain("?");
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it("downloads presigned S3 print art immediately and stores a permanent A3 master", async () => {
    const source = "https://bucket.example/poster.png?X-Amz-Signature=test-signature";
    const bytes = rgbPng(4096, 6144, [100, 120, 140]);
    const fetchMock = vi.fn(async (url: string) => url.includes("api.runpod.ai")
      ? Response.json({ id: "print-job", status: "COMPLETED", output: { images: [{ type: "s3_url", data: source }] } })
      : new Response(new Uint8Array(bytes), { headers: { "content-type": "image/png" } }));
    vi.stubGlobal("fetch", fetchMock);
    const upload = vi.fn(async (received: Buffer) => {
      expect(received.equals(bytes)).toBe(true);
      return { url: "https://app-storage.example/master.png", key: "master.png", backend: "s3" as const };
    });
    expect(isSafeArtworkUrl(source)).toBe(true);
    const image = await new RunPodImageProvider({ upload }).generate(request);
    expect(image.url).toBe("https://app-storage.example/master.png");
    expect(fetchMock.mock.calls[1][0]).toBe(source);
    expect(upload).toHaveBeenCalledOnce();
    expect(await preparePrintFile(image.url)).toMatchObject({ width: 4096, height: 6144 });
  });

  it("uploads base64 output without retaining it in the URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "base64-job", status: "COMPLETED", output: { images: [{ type: "base64", data: "cG5n" }] } })));
    const upload = vi.fn<(bytes: Buffer) => Promise<{ url: string; key: string; backend: "s3" }>>().mockResolvedValue({ url: "https://app-storage.example/native.png", key: "native.png", backend: "s3" });
    const image = await new RunPodImageProvider({ upload }).generate(request);
    expect(image.url).toBe("https://app-storage.example/native.png");
    expect(image.provenance).toMatchObject({
      version: 1, provider: "runpod", requestedSeed: 1,
      requestedAspectRatio: "2:3", printRequested: true, jobId: "base64-job",
    });
    expect(image.provenance?.workflowSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(image.provenance?.templateSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(image.provenance?.workflowSha256).not.toBe(image.provenance?.templateSha256);
    expect(JSON.stringify(image.provenance)).not.toContain(request.prompt);
    expect(upload.mock.calls[0][0]).toEqual(Buffer.from("png"));
  });

  it("includes job id, output keys and worker errors without encoded data or signed URLs", async () => {
    const encoded = Buffer.alloc(512, 42).toString("base64");
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ id: "missing-job", status: "IN_QUEUE" }))
      .mockResolvedValueOnce(Response.json({ status: "COMPLETED", output: {
        images: [], errors: ["S3 upload failed", `https://bucket.example/a?X-Amz-Signature=private-value`, `data:image/png;base64,${encoded}`],
      } })));
    const error = await new RunPodImageProvider({ pollMs: 0 }).generate(request).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("missing-job");
    expect(message).toContain("images, errors");
    expect(message).toContain("S3 upload failed");
    expect(message).not.toMatch(/private-value|X-Amz|data:image|https:\/\//);
    expect(message).not.toContain(encoded);
  });

  it("does not retain a temporary S3 URL when download or upload fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("api.runpod.ai")
      ? Response.json({ id: "storage-job", status: "COMPLETED", output: { images: [{ type: "s3_url", data: "https://bucket.example/art?signature=private" }] } })
      : new Response("not found", { status: 404 })));
    await expect(new RunPodImageProvider({ upload: async () => null }).generate(request)).rejects.toThrow("storage-job");
  });

  it("does not mistake a worker error message for image data", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      id: "worker-error", status: "COMPLETED", output: { message: "S3 upload failed", errors: ["Bucket not configured"] },
    })));
    await expect(new RunPodImageProvider().generate(request)).rejects.toThrow(/worker-error.*Bucket not configured/);
  });

  it("rejects private bucket addresses before downloading", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      id: "unsafe-job", status: "COMPLETED", output: { images: [{ type: "s3_url", data: "https://127.0.0.1/art.png" }] },
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(new RunPodImageProvider({ upload: async () => null }).generate(request)).rejects.toThrow("unsafe-job");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
