import { afterEach, describe, expect, it, vi } from "vitest";
import { getImageProvider, setImageProviderForTests } from "@/adapters/image";
import { OpenAIImageProvider } from "@/adapters/image/openai";
import { RunPodImageProvider } from "@/adapters/image/runpod";
import { getLLMProvider } from "@/adapters/llm";
import { OpenAILLMProvider } from "@/adapters/llm/openai";
import { config, integrationStatus } from "@/lib/config";
import { connectionHealth } from "@/lib/health";
import { classifyProviderStatus, probeConnections } from "@/lib/provider-probe";
import { setupChecklist, stepStatus, SETUP_STEPS } from "@/lib/setup-guide";

const ENV_KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
  "OPENAI_IMAGE_MODEL",
  "IMAGE_API_KEY",
  "IMAGE_BASE_URL",
  "IMAGE_MODEL",
  "IMAGE_PROVIDER",
  "LLM_PROVIDER",
  "OLLAMA_API_KEY",
  "OLLAMA_MODEL",
  "OMNIROUTE_API_KEY",
  "OMNIROUTE_BASE_URL",
  "OMNIROUTE_MODEL",
  "OMNIROUTE_IMAGE_MODEL",
  "RUNPOD_API_KEY",
  "RUNPOD_ENDPOINT_ID",
  "RUNPOD_COMFY_WORKFLOW",
  "APP_URL",
  "PUBLISH_MODE",
] as const;

const original = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreEnv() {
  for (const key of ENV_KEYS) {
    const value = original[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function jsonResponse(status: number, body: unknown) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
  };
}

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string };

function installFetch(handler: (index: number) => ReturnType<typeof jsonResponse>) {
  const calls: Array<{ url: string; init?: FetchInit }> = [];
  vi.stubGlobal("fetch", (url: string, init?: FetchInit) => {
    const index = calls.length;
    calls.push({ url, init });
    return Promise.resolve(handler(index));
  });
  return calls;
}

const listing = {
  keyword: "swiss alps wall art",
  niche: "alpine" as const,
  productType: "digital" as const,
  seed: 1,
};

const chatOk = jsonResponse(200, {
  choices: [{ message: { content: JSON.stringify({ title: "Alps", tags: ["alps"], body: "A print." }) } }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});

afterEach(() => {
  restoreEnv();
  setImageProviderForTests(null);
  vi.unstubAllGlobals();
});

describe("image endpoint fallbacks", () => {
  it("uses OPENAI_* when IMAGE_* is unset", () => {
    delete process.env.IMAGE_API_KEY;
    delete process.env.IMAGE_BASE_URL;
    delete process.env.IMAGE_MODEL;
    process.env.OPENAI_API_KEY = "sk-text";
    process.env.OPENAI_BASE_URL = "https://ollama.com/v1/";
    process.env.OPENAI_IMAGE_MODEL = "gpt-image-1";
    expect(config.imageApiKey).toBe("sk-text");
    expect(config.imageBaseUrl).toBe("https://ollama.com/v1");
    expect(config.imageModel).toBe("gpt-image-1");
    expect(config.openaiBaseUrl).toBe("https://ollama.com/v1");
  });

  it("prefers IMAGE_* so art is not posted to the text host", async () => {
    process.env.OPENAI_API_KEY = "sk-text";
    process.env.OPENAI_BASE_URL = "https://ollama.com/v1";
    process.env.OPENAI_IMAGE_MODEL = "gpt-image-1";
    process.env.IMAGE_API_KEY = "img-key";
    process.env.IMAGE_BASE_URL = "https://images.example/v1/";
    process.env.IMAGE_MODEL = "flux-dev";
    const calls = installFetch(() => jsonResponse(200, { data: [{ b64_json: "abc" }] }));

    await new OpenAIImageProvider().generate({ prompt: "alpine poster", niche: "alpine", seed: 1 });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://images.example/v1/images/generations");
    expect(calls[0].init?.headers?.Authorization).toBe("Bearer img-key");
    expect(JSON.parse(String(calls[0].init?.body)).model).toBe("flux-dev");
    expect(calls.some((call) => call.url.includes("ollama.com"))).toBe(false);
  });
});

describe("provider selection", () => {
  it("upscales the saved RunPod image without enlarging the diffusion latent", async () => {
    process.env.RUNPOD_API_KEY = "runpod-test-key";
    process.env.RUNPOD_ENDPOINT_ID = "endpoint-test";
    process.env.RUNPOD_COMFY_WORKFLOW = JSON.stringify({
      "6": { class_type: "CLIPTextEncode", inputs: { text: "{{PROMPT}}" } },
      "9": { class_type: "SaveImage", inputs: { images: ["8", 0] } },
    });
    const calls = installFetch(() => jsonResponse(200, { status: "COMPLETED", output: { images: [{ type: "base64", data: "cG5n" }] } }));
    await new RunPodImageProvider().generate({ prompt: "clean art", niche: "gothic", seed: 1 });
    const workflow = JSON.parse(String(calls[0].init?.body)).input.workflow;
    expect(workflow["9"].inputs.images).toEqual(["10", 0]);
    expect(workflow["10"]).toMatchObject({
      class_type: "ImageScale",
      inputs: { image: ["8", 0], width: 3510, height: 5265, crop: "disabled" },
    });
  });

  it("runs a ComfyUI workflow on RunPod and extracts the generated image", async () => {
    process.env.IMAGE_PROVIDER = "runpod";
    process.env.RUNPOD_API_KEY = "runpod-test-key";
    process.env.RUNPOD_ENDPOINT_ID = "endpoint-test";
    process.env.RUNPOD_COMFY_WORKFLOW = JSON.stringify({
      "6": { inputs: { text: "{{PROMPT}}" } },
      "5": { inputs: { seed: "{{SEED}}", width: "{{WIDTH}}", height: "{{HEIGHT}}" } },
    });
    const calls = installFetch((index) =>
      index === 0
        ? jsonResponse(200, { id: "job-test", status: "IN_QUEUE" })
        : jsonResponse(200, {
            id: "job-test",
            status: "COMPLETED",
            output: { images: [{ type: "base64", data: "cG5n" }] },
          }),
    );

    expect(getImageProvider().name).toBe("runpod");
    const image = await new RunPodImageProvider({ pollMs: 0 }).generate({
      prompt: "a test poster",
      niche: "alpine",
      seed: 123,
      aspectRatio: "1:1",
    });

    expect(calls.map((call) => call.url)).toEqual([
      "https://api.runpod.ai/v2/endpoint-test/run",
      "https://api.runpod.ai/v2/endpoint-test/status/job-test",
    ]);
    expect(calls[0].init?.headers?.Authorization).toBe(["Bearer", "runpod-test-key"].join(" "));
    expect(JSON.parse(String(calls[0].init?.body)).input.workflow).toEqual({
      "6": { inputs: { text: "a test poster" } },
      "5": { inputs: { seed: 123, width: 1024, height: 1024 } },
    });
    expect(image).toMatchObject({
      url: "data:image/png;base64,cG5n",
      provider: "runpod",
      costChf: 0.05,
    });
    expect(integrationStatus(false).find((row) => row.id === "images")?.detail).toContain("RunPod Serverless");
    expect(connectionHealth({ etsyConnected: false }).find((row) => row.id === "images")?.label).toBe("Ready");
  });

  it("tests RunPod image generation with the configured workflow", async () => {
    process.env.IMAGE_PROVIDER = "runpod";
    process.env.RUNPOD_API_KEY = "runpod-test-key";
    process.env.RUNPOD_ENDPOINT_ID = "endpoint-test";
    process.env.RUNPOD_COMFY_WORKFLOW = JSON.stringify({ "6": { inputs: { text: "{{PROMPT}}" } } });
    const calls = installFetch(() =>
      jsonResponse(200, { status: "COMPLETED", output: { images: [{ type: "base64", data: "cG5n" }] } }),
    );

    const probes = await probeConnections();

    expect(probes.image).toMatchObject({ status: "ok", httpStatus: 200 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.runpod.ai/v2/endpoint-test/run");
    expect(JSON.stringify(probes)).not.toContain("runpod-test-key");
  });

  it("selects Ollama Cloud for text and leaves images on their own host", async () => {
    process.env.LLM_PROVIDER = "ollama";
    process.env.OLLAMA_API_KEY = "ollama-test-key";
    delete process.env.OLLAMA_MODEL;
    process.env.OPENAI_BASE_URL = "https://api.openai.com/v1";
    process.env.OPENAI_API_KEY = "sk-text";
    const calls = installFetch(() => chatOk);

    expect(getLLMProvider().name).toBe("ollama");
    expect(config.ollama.baseUrl).toBe("https://ollama.com/v1");
    expect(config.ollama.model).toBe("gemma4:31b");
    const copy = await new OpenAILLMProvider({
      name: "ollama",
      apiKey: config.ollama.apiKey,
      baseUrl: config.ollama.baseUrl,
      model: config.ollama.model,
      missingKey: "OLLAMA_API_KEY missing",
    }).writeListing(listing);

    expect(calls[0].url).toBe("https://ollama.com/v1/chat/completions");
    expect(calls[0].init?.headers?.Authorization).toBe("Bearer ollama-test-key");
    expect(JSON.parse(String(calls[0].init?.body)).model).toBe("gemma4:31b");
    expect(copy.provider).toBe("ollama:gemma4:31b");
    expect(calls.some((call) => call.url.includes("/images"))).toBe(false);

    delete process.env.OLLAMA_API_KEY;
    expect(config.llmProvider).toBe("mock");
    expect(getLLMProvider({ demo: true }).name).toBe("mock-template");
    expect(() => getLLMProvider({ demo: false })).toThrow(/OLLAMA_API_KEY/);
  });

  it("selects OmniRoute for chat and for /images/generations only", async () => {
    process.env.LLM_PROVIDER = "omniroute";
    process.env.IMAGE_PROVIDER = "omniroute";
    process.env.OMNIROUTE_API_KEY = "omni-test-key";
    process.env.OMNIROUTE_BASE_URL = "https://omni.example/v1/";
    process.env.OMNIROUTE_MODEL = "writer";
    process.env.OMNIROUTE_IMAGE_MODEL = "painter";
    process.env.OPENAI_BASE_URL = "https://ollama.com/v1";

    expect(getLLMProvider().name).toBe("omniroute");
    expect(getImageProvider().name).toBe("omniroute");

    const chatCalls = installFetch(() => chatOk);
    const copy = await getLLMProvider().writeListing(listing);
    expect(chatCalls[0].url).toBe("https://omni.example/v1/chat/completions");
    expect(JSON.parse(String(chatCalls[0].init?.body)).model).toBe("writer");
    expect(copy.provider).toBe("omniroute:writer");

    const imageCalls = installFetch(() => jsonResponse(200, { data: [{ url: "https://cdn.example/a.png" }] }));
    const image = await getImageProvider().generate({ prompt: "alpine poster", niche: "alpine", seed: 1 });
    expect(imageCalls.map((call) => call.url)).toEqual(["https://omni.example/v1/images/generations"]);
    expect(imageCalls[0].init?.headers?.Authorization).toBe("Bearer omni-test-key");
    expect(JSON.parse(String(imageCalls[0].init?.body)).model).toBe("painter");
    expect(image).toMatchObject({ url: "https://cdn.example/a.png", provider: "omniroute" });

    const b64Calls = installFetch(() => jsonResponse(200, { data: [{ b64_json: "abc", media_type: "image/png" }] }));
    const b64 = await getImageProvider().generate({ prompt: "alpine poster", niche: "alpine", seed: 1 });
    expect(b64Calls).toHaveLength(1);
    expect(b64.url).toBe("data:image/png;base64,abc");

    const rows = integrationStatus(false);
    const blob = JSON.stringify(rows);
    expect(rows.find((row) => row.id === "llm")?.detail).toBe("OmniRoute · writer · https://omni.example/v1");
    expect(rows.find((row) => row.id === "images")?.detail).toBe("OmniRoute · painter · https://omni.example/v1");
    expect(blob).not.toContain("omni-test-key");

    const checks = connectionHealth({ etsyConnected: false });
    expect(checks.find((check) => check.id === "llm")?.level).toBe("green");
    expect(checks.find((check) => check.id === "images")?.detail).toBe("OmniRoute · painter · https://omni.example/v1");
    expect(JSON.stringify(checks)).not.toContain("omni-test-key");
  });

  it("stays on the template writer when a named provider has no key", () => {
    process.env.LLM_PROVIDER = "ollama";
    delete process.env.OLLAMA_API_KEY;
    process.env.IMAGE_PROVIDER = "omniroute";
    delete process.env.OMNIROUTE_API_KEY;
    const checks = connectionHealth({ etsyConnected: false });
    expect(config.llmProvider).toBe("mock");
    expect(checks.find((check) => check.id === "llm")).toMatchObject({ level: "red", label: "Key missing" });
    expect(checks.find((check) => check.id === "images")).toMatchObject({ level: "red", label: "Key missing" });
  });
});

describe("connection probe", () => {
  it("classifies provider failures", () => {
    expect(classifyProviderStatus(200, "ok")).toBe("ok");
    expect(classifyProviderStatus(401, "unauthorized")).toBe("401");
    expect(classifyProviderStatus(402, "insufficient credits")).toBe("402");
    expect(classifyProviderStatus(404, "not found")).toBe("404");
    expect(classifyProviderStatus(404, '{"error":"model_not_found"}')).toBe("model not found");
    expect(classifyProviderStatus(400, "model does not exist")).toBe("model not found");
  });

  it("pings text on Ollama and images on IMAGE_BASE_URL, and hides the key", async () => {
    process.env.LLM_PROVIDER = "ollama";
    process.env.OLLAMA_API_KEY = "ollama-test-key";
    process.env.OLLAMA_MODEL = "gemma4:31b";
    process.env.IMAGE_PROVIDER = "openai";
    process.env.IMAGE_API_KEY = "img-key";
    process.env.IMAGE_BASE_URL = "https://images.example/v1";
    process.env.IMAGE_MODEL = "flux-dev";
    process.env.OPENAI_BASE_URL = "https://ollama.com/v1";
    const calls = installFetch((index) => (index === 0 ? jsonResponse(401, "bad key") : jsonResponse(404, "no image route")));

    const probes = await probeConnections();

    expect(calls.map((call) => call.url)).toEqual([
      "https://ollama.com/v1/chat/completions",
      "https://images.example/v1/images/generations",
    ]);
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({ model: "gemma4:31b", max_tokens: 1 });
    expect(probes.text).toMatchObject({ status: "401", detail: "401" });
    expect(probes.image).toMatchObject({ status: "404", detail: "404" });
    expect(JSON.stringify(probes)).not.toContain("ollama-test-key");
    expect(JSON.stringify(probes)).not.toContain("img-key");
  });

  it("reports model-not-found and skips a mock image provider", async () => {
    process.env.LLM_PROVIDER = "omniroute";
    process.env.OMNIROUTE_API_KEY = "omni-test-key";
    process.env.OMNIROUTE_BASE_URL = "https://omni.example/v1";
    process.env.OMNIROUTE_MODEL = "missing-writer";
    delete process.env.IMAGE_PROVIDER;
    const calls = installFetch(() => jsonResponse(404, { error: { code: "model_not_found" } }));

    const probes = await probeConnections();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://omni.example/v1/chat/completions");
    expect(probes.text.status).toBe("model not found");
    expect(probes.image.status).toBe("skipped");
  });
});

describe("setup guide providers", () => {
  it("documents separate text and image hosts and keeps publish mode dry-run", () => {
    const llm = SETUP_STEPS.find((step) => step.id === "llm");
    const text = `${llm?.summary}\n${llm?.bullets.join("\n")}\n${setupChecklist()}`;
    expect(text).toContain("https://ollama.com/v1");
    expect(text).toContain("IMAGE_BASE_URL");
    expect(text).toContain("IMAGE_PROVIDER=omniroute");
    expect(text).toContain("LLM_PROVIDER=ollama");
    expect(text).toContain("/images/generations");
    expect(setupChecklist()).toContain("PUBLISH_MODE=dry-run");
    expect(setupChecklist()).not.toContain("PUBLISH_MODE=live");
    expect(stepStatus(llm!, { OLLAMA_API_KEY: true }, false)).toBe("ready");
    expect(stepStatus(llm!, { LLM_PROVIDER: true }, false)).toBe("partial");
    expect(stepStatus(llm!, {}, false)).toBe("missing");
  });
});
