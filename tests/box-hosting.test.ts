import { afterEach, describe, expect, it, vi } from "vitest";
import { assertFreeStorage, uploadImageBytes } from "@/lib/object-storage";
import { downloadModel, loadRealEsrganSession, resolveModelSourceForTests, setUpscaleSessionForTests, upscaleArtwork, upscaleTiledRgb, upscaleViaWorker } from "@/pipeline/upscale";

const completed = vi.hoisted(() => vi.fn<(request: Request) => Promise<Response>>(async () => Response.json({ postStore: "done" })));
vi.mock("@/app/api/cron/upscale-jobs/complete/route", () => ({ POST: completed }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setUpscaleSessionForTests(undefined);
  completed.mockClear();
});

const target = { minW: 2, minH: 2, targetW: 4, targetH: 4 };

function dashboard() {
  vi.stubEnv("AUTOPILOT_EXECUTION", "box");
  vi.stubEnv("AUTOPILOT_BOX_WORKER", "0");
}

describe("box dashboard resource boundary", () => {
  it("cannot download or load a model, even with a cached ONNX session", async () => {
    dashboard();
    vi.stubEnv("REALESRGAN_MODEL_PATH", "/pretend/local/model.onnx");
    const network = vi.fn<typeof fetch>();
    setUpscaleSessionForTests({ inputNames: [], outputNames: [], run: vi.fn() });
    expect(await downloadModel("https://models.example/model.onnx", undefined, network)).toBeNull();
    expect(await loadRealEsrganSession()).toBeNull();
    expect(await resolveModelSourceForTests(network)).toMatchObject({ source: null, reason: "model loading runs on the local box" });
    expect(network).not.toHaveBeenCalled();
  });

  it("refuses local and remote upscale entrypoints before reading artwork or calling a worker", async () => {
    dashboard();
    const network = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", network);
    await expect(upscaleArtwork("https://art.example/a.png", target)).rejects.toThrow(/local box/);
    await expect(upscaleViaWorker("https://art.example/a.png", target, {}, network)).rejects.toThrow(/local box/);
    await expect(upscaleTiledRgb({ data: new Uint8Array(3), width: 1, height: 1, channels: 3 }, {
      inputNames: ["x"], outputNames: ["y"], run: vi.fn(),
    })).rejects.toThrow(/local box/);
    expect(network).not.toHaveBeenCalled();
  });

  it("allows an explicitly local worker to use its ONNX session", async () => {
    dashboard();
    vi.stubEnv("AUTOPILOT_BOX_WORKER", "1");
    const session = { inputNames: ["x"], outputNames: ["y"], run: vi.fn() };
    setUpscaleSessionForTests(session);
    expect(await loadRealEsrganSession()).toBe(session);
  });

  it("bakes web execution switches into a box build and removes ONNX native files from its trace", async () => {
    dashboard();
    vi.resetModules();
    const { default: nextConfig } = await import("../next.config");
    expect(nextConfig.env).toMatchObject({ AUTOPILOT_EXECUTION: "box", AUTOPILOT_BOX_WORKER: "0", FREE_ONLY_MODE: "true" });
    expect(nextConfig.serverExternalPackages).toContain("onnxruntime-node");
    expect(nextConfig.outputFileTracingExcludes?.["/*"]).toContain("./node_modules/onnxruntime-node/**");
  });
});

describe("strict free object storage", () => {
  function s3(endpoint: string) {
    vi.stubEnv("FREE_ONLY_MODE", "true");
    vi.stubEnv("SUPABASE_STORAGE_PLAN", "free");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "test-key");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test-secret");
    vi.stubEnv("S3_BUCKET", "artwork");
    vi.stubEnv("AWS_ENDPOINT_URL_S3", endpoint);
  }

  it.each([
    "https://project.supabase.co/storage/v1/s3",
    "https://project.storage.supabase.co/storage/v1/s3/",
  ])("accepts the explicitly declared Supabase Free endpoint %s", (endpoint) => {
    s3(endpoint);
    expect(() => assertFreeStorage()).not.toThrow();
  });

  it.each([
    "https://s3.amazonaws.com",
    "https://project.supabase.co.attacker.example/storage/v1/s3",
    "https://project.supabase.co/not-storage",
    "http://project.supabase.co/storage/v1/s3",
    "https://user:password@project.supabase.co/storage/v1/s3",
  ])("rejects metered or misleading storage endpoint %s before uploading", async (endpoint) => {
    s3(endpoint);
    const network = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", network);
    await expect(uploadImageBytes(Buffer.from("test"), "image/png")).rejects.toThrow(/Free-only storage/);
    expect(network).not.toHaveBeenCalled();
  });

  it("requires an explicit provider-plan declaration and rejects paid Blob storage", async () => {
    s3("https://project.supabase.co/storage/v1/s3");
    vi.stubEnv("SUPABASE_STORAGE_PLAN", "");
    expect(() => assertFreeStorage()).toThrow(/SUPABASE_STORAGE_PLAN/);
    vi.stubEnv("AWS_ACCESS_KEY_ID", "");
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test-token");
    await expect(uploadImageBytes(Buffer.from("test"), "image/png")).rejects.toThrow(/Free-only storage/);
  });
});

it("legacy box uploads keep the issued S3 key and run completion locally", async () => {
  dashboard();
  vi.stubEnv("AUTOPILOT_BOX_WORKER", "1");
  const network = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ key: "designs/issued.png", putUrl: "https://storage.example/signed-put" }))
    .mockResolvedValueOnce(new Response(null, { status: 200 }));
  const { report } = await import("../workers/upscaler/pull");
  const result = await report(123, { width: 12, height: 16 }, Buffer.from("upscaled"), network);
  expect(result.status).toBe(200);
  expect(network).toHaveBeenCalledTimes(2);
  expect(completed).toHaveBeenCalledOnce();
  const request = completed.mock.calls[0]?.[0] as Request | undefined;
  expect(request).toBeDefined();
  expect(new URL(request!.url).searchParams.get("key")).toBe("designs/issued.png");
  expect(new URL(request!.url).searchParams.get("designId")).toBe("123");
});
