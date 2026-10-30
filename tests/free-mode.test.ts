import { afterEach, describe, expect, it, vi } from "vitest";
import { getImageProvider, setImageProviderForTests } from "@/adapters/image";
import { getLLMProvider, setLLMProviderForTests } from "@/adapters/llm";
import { CloudflareImageProvider } from "@/adapters/image/cloudflare";
import { OpenAIImageProvider } from "@/adapters/image/openai";
import { ReplicateImageProvider } from "@/adapters/image/replicate";
import { HiggsfieldImageProvider } from "@/adapters/image/higgsfield";
import { RunPodImageProvider } from "@/adapters/image/runpod";
import { OpenAILLMProvider } from "@/adapters/llm/openai";
import { freeOnlyMode, localOllamaConfig, validateLocalOllamaUrl } from "@/lib/free-mode";
import { probeConnections } from "@/lib/provider-probe";

const brief = { keyword: "swiss mountain print", niche: "alpine" as const, productType: "digital" as const, seed: 1 };
const image = { prompt: "mountain", niche: "alpine" as const, seed: 1 };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setImageProviderForTests(null);
  setLLMProviderForTests(null);
});

describe("strict free-only inference policy", () => {
  it("is opt-in and refuses misspelled switch values", () => {
    vi.stubEnv("FREE_ONLY_MODE", "");
    expect(freeOnlyMode()).toBe(false);
    vi.stubEnv("FREE_ONLY_MODE", "true");
    expect(freeOnlyMode()).toBe(true);
    vi.stubEnv("FREE_ONLY_MODE", "TRUE");
    expect(() => freeOnlyMode()).toThrow("true or false");
  });

  it.each(["openai", "higgsfield", "replicate", "runpod", "omniroute"])("blocks paid %s image selection before a request", (name) => {
    vi.stubEnv("FREE_ONLY_MODE", "true");
    vi.stubEnv("IMAGE_PROVIDER", name);
    expect(() => getImageProvider()).toThrow("FREE_ONLY_MODE blocks");
  });

  it("requires an explicit Workers Free declaration and rejects a paid fallback before generation", () => {
    vi.stubEnv("FREE_ONLY_MODE", "true");
    vi.stubEnv("IMAGE_PROVIDER", "cloudflare");
    vi.stubEnv("CLOUDFLARE_WORKERS_PLAN", "paid");
    expect(() => getImageProvider()).toThrow("CLOUDFLARE_WORKERS_PLAN=free");
    vi.stubEnv("CLOUDFLARE_WORKERS_PLAN", "free");
    vi.stubEnv("IMAGE_FALLBACK_PROVIDER", "openai");
    expect(() => getImageProvider()).toThrow("fallback");
    vi.stubEnv("IMAGE_FALLBACK_PROVIDER", "");
    expect(getImageProvider().name).toBe("cloudflare");
  });

  it("blocks direct paid adapter methods and connection probes, even when stale keys remain configured", async () => {
    vi.stubEnv("FREE_ONLY_MODE", "true");
    vi.stubEnv("IMAGE_PROVIDER", "openai");
    vi.stubEnv("LLM_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", "stale-secret");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const provider of [new OpenAIImageProvider(), new RunPodImageProvider(), new ReplicateImageProvider(), new HiggsfieldImageProvider()]) {
      await expect(provider.generate(image)).rejects.toThrow("FREE_ONLY_MODE blocks");
    }
    await expect(new OpenAILLMProvider().writeListing(brief)).rejects.toThrow("FREE_ONLY_MODE blocks");
    await expect(new OpenAILLMProvider().assessImage("data:image/png;base64,eA==")).rejects.toThrow("FREE_ONLY_MODE blocks");
    expect(() => getLLMProvider()).toThrow("FREE_ONLY_MODE blocks");
    const probes = await probeConnections();
    expect(probes.text.status).toBe("error");
    expect(probes.image.status).toBe("error");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses arbitrary Cloudflare models without consuming a neuron", async () => {
    vi.stubEnv("FREE_ONLY_MODE", "true");
    vi.stubEnv("CLOUDFLARE_WORKERS_PLAN", "free");
    vi.stubEnv("CLOUDFLARE_IMAGE_MODEL", "@cf/unknown/paid-model");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(new CloudflareImageProvider().generate(image)).rejects.toThrow("reviewed Workers Free");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps demo placeholders available without permitting a live mock writer", () => {
    vi.stubEnv("FREE_ONLY_MODE", "true");
    vi.stubEnv("IMAGE_PROVIDER", "mock");
    vi.stubEnv("IMAGE_FALLBACK_PROVIDER", "");
    vi.stubEnv("LLM_PROVIDER", "mock");
    expect(getImageProvider({ demo: true }).name).toBe("mock");
    expect(getLLMProvider({ demo: true }).name).toBe("mock-template");
    expect(() => getLLMProvider({ demo: false })).toThrow("Configure LLM_PROVIDER");
  });
});

describe("local Ollama", () => {
  it.each([
    "https://api.openai.com/v1", "https://ollama.com/v1", "http://169.254.169.254/v1",
    "http://ollama.internal/v1", "http://localhost:11434/v1?cloud=true", "http://user:pass@localhost:11434/v1",
  ])("refuses non-local or ambiguous target %s", (url) => {
    expect(() => validateLocalOllamaUrl(url)).toThrow("OLLAMA_LOCAL_BASE_URL");
  });

  it.each(["http://127.0.0.1:11434/v1", "http://localhost:11434/v1/", "http://192.168.1.20:11434/v1", "http://[::1]:11434/v1"])("accepts explicit local target %s", (url) => {
    expect(validateLocalOllamaUrl(url)).toBe(url.replace(/\/$/, ""));
  });

  it.each(["gemini-3:cloud", "gpt-oss:120b-cloud", "https://paid.example/model"])("refuses local Ollama forwarding to remote model %s", (model) => {
    vi.stubEnv("OLLAMA_LOCAL_MODEL", model);
    expect(() => localOllamaConfig()).toThrow("installed locally");
  });

  it("requires an installed model and reports zero API cost for local copy and vision", async () => {
    vi.stubEnv("FREE_ONLY_MODE", "true");
    vi.stubEnv("LLM_PROVIDER", "ollama-local");
    vi.stubEnv("OLLAMA_LOCAL_MODEL", "");
    expect(() => localOllamaConfig()).toThrow("OLLAMA_LOCAL_MODEL missing");
    vi.stubEnv("OLLAMA_LOCAL_MODEL", "local-text-model");
    vi.stubEnv("OLLAMA_LOCAL_VISION_MODEL", "local-vision-model");
    // A stale global cloud setting must not override the explicitly local vision model.
    vi.stubEnv("VISION_MODEL", "paid-cloud-vision");
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: JSON.stringify({ title: "Mountain", tags: [], body: "Art" }) } }], usage: { prompt_tokens: 1000, completion_tokens: 1000 } }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: JSON.stringify({ score: 8, defects: [], notes: [], text: false, empty: false, frameOnly: false, artifacts: false }) } }], usage: { prompt_tokens: 1000, completion_tokens: 1000 } }));
    vi.stubGlobal("fetch", fetch);
    const llm = getLLMProvider();
    expect((await llm.writeListing(brief)).costChf).toBe(0);
    expect((await llm.assessImage!("data:image/png;base64,eA==")).costChf).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][0]).toBe("http://127.0.0.1:11434/v1/chat/completions");
    const vision = fetch.mock.calls[1][1];
    expect(JSON.parse(vision.body).model).toBe("local-vision-model");
    expect(vision.redirect).toBe("error");
  });

  it("still rejects missing or invalid local vision evidence", async () => {
    vi.stubEnv("FREE_ONLY_MODE", "true");
    vi.stubEnv("LLM_PROVIDER", "ollama-local");
    vi.stubEnv("OLLAMA_LOCAL_MODEL", "text-only");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ choices: [{ message: { content: '{"score":8}' } }] })));
    await expect(getLLMProvider().assessImage!("data:image/png;base64,eA==")).rejects.toThrow("invalid assessment");
  });
});
