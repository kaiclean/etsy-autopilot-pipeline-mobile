import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIImageProvider } from "@/adapters/image/openai";
import { OpenAILLMProvider } from "@/adapters/llm/openai";
import { config, integrationStatus } from "@/lib/config";

const ENV_KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
  "OPENAI_IMAGE_MODEL",
  "APP_URL",
  "LLM_PROVIDER",
  "IMAGE_PROVIDER",
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
  const fetchMock = vi.fn((url: string, init?: FetchInit) => {
    const index = calls.length;
    calls.push({ url, init });
    return Promise.resolve(handler(index));
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

afterEach(() => {
  restoreEnv();
  vi.unstubAllGlobals();
});

describe("OpenAI-compatible base URL", () => {
  it("defaults to the OpenAI API and strips a trailing slash", () => {
    delete process.env.OPENAI_BASE_URL;
    expect(config.openaiBaseUrl).toBe("https://api.openai.com/v1");
    process.env.OPENAI_BASE_URL = "https://openrouter.ai/api/v1/";
    expect(config.openaiBaseUrl).toBe("https://openrouter.ai/api/v1");
    expect(config.publishMode).toBe("dry-run");
  });

  it("keeps publish mode dry-run unless explicitly live", () => {
    delete process.env.PUBLISH_MODE;
    expect(config.publishMode).toBe("dry-run");
    process.env.PUBLISH_MODE = "live";
    expect(config.publishMode).toBe("live");
  });

  it("surfaces base URL and image model on the settings integrations", () => {
    process.env.LLM_PROVIDER = "openai";
    process.env.IMAGE_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.OPENAI_BASE_URL = "https://openrouter.ai/api/v1";
    process.env.OPENAI_MODEL = "openai/gpt-4.1-mini";
    process.env.OPENAI_IMAGE_MODEL = "google/gemini-2.5-flash-image";

    const rows = integrationStatus(false);
    const images = rows.find((row) => row.id === "images");
    const llm = rows.find((row) => row.id === "llm");
    expect(images?.detail).toBe(
      "OpenAI-compatible · google/gemini-2.5-flash-image · https://openrouter.ai/api/v1",
    );
    expect(images?.envVars).toEqual(
      expect.arrayContaining(["OPENAI_BASE_URL", "OPENAI_IMAGE_MODEL", "OPENAI_API_KEY"]),
    );
    expect(llm?.detail).toBe("OpenAI-compatible · openai/gpt-4.1-mini · https://openrouter.ai/api/v1");
    expect(llm?.envVars).toContain("OPENAI_BASE_URL");
  });
});

describe("OpenAI image adapter", () => {
  it("posts to /images/generations on the default OpenAI host", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_IMAGE_MODEL;
    const calls = installFetch(() => jsonResponse(200, { data: [{ b64_json: "abc", media_type: "image/png" }] }));

    const image = await new OpenAIImageProvider().generate({
      prompt: "alpine poster",
      niche: "alpine",
      seed: 1,
      aspectRatio: "2:3",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.openai.com/v1/images/generations");
    const headers = calls[0].init?.headers ?? {};
    expect(headers.Authorization).toBe("Bearer sk-test");
    expect(headers["HTTP-Referer"]).toBeUndefined();
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      model: "gpt-image-1",
      size: "1024x1536",
      aspect_ratio: "2:3",
      n: 1,
    });
    expect(image.url).toBe("data:image/png;base64,abc");
    expect(image.costChf).toBe(0.05);
  });

  it("tries OpenRouter /images first, then /images/generations, and uses reported cost", async () => {
    process.env.OPENAI_API_KEY = "sk-or";
    process.env.OPENAI_BASE_URL = "https://openrouter.ai/api/v1";
    process.env.OPENAI_IMAGE_MODEL = "google/gemini-2.5-flash-image";
    process.env.APP_URL = "https://shop.example";
    const responses = [
      jsonResponse(404, "missing"),
      jsonResponse(200, { data: [{ url: "https://cdn.example/a.png" }], usage: { cost: 0.04 } }),
    ];
    const calls = installFetch((index) => responses[index]);

    const image = await new OpenAIImageProvider().generate({
      prompt: "alpine poster",
      niche: "alpine",
      seed: 1,
    });

    expect(calls.map((call) => call.url)).toEqual([
      "https://openrouter.ai/api/v1/images",
      "https://openrouter.ai/api/v1/images/generations",
    ]);
    const headers = calls[0].init?.headers ?? {};
    expect(headers["HTTP-Referer"]).toBe("https://shop.example");
    expect(headers["X-Title"]).toBe("DesignedByKaiArt");
    expect(JSON.parse(String(calls[0].init?.body)).model).toBe("google/gemini-2.5-flash-image");
    expect(image).toMatchObject({ url: "https://cdn.example/a.png", costChf: 0.04, provider: "openai" });
  });
});

describe("OpenAI LLM adapter", () => {
  it("posts chat completions to the configured base URL", async () => {
    process.env.OPENAI_API_KEY = "sk-or";
    process.env.OPENAI_BASE_URL = "https://openrouter.ai/api/v1/";
    process.env.OPENAI_MODEL = "openai/gpt-4.1-mini";
    const calls = installFetch(() =>
      jsonResponse(200, {
        choices: [{ message: { content: JSON.stringify({ title: "Alps", tags: ["alps"], body: "A print." }) } }],
        usage: { prompt_tokens: 1000, completion_tokens: 500 },
      }),
    );

    const copy = await new OpenAILLMProvider().writeListing({
      keyword: "swiss alps wall art",
      niche: "alpine",
      productType: "digital",
      seed: 1,
    });

    expect(calls[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(JSON.parse(String(calls[0].init?.body)).model).toBe("openai/gpt-4.1-mini");
    expect(copy.provider).toBe("openai:openai/gpt-4.1-mini");
    expect(copy.title).toBe("Alps");
    expect(copy.costChf).toBeGreaterThan(0);
  });
});
