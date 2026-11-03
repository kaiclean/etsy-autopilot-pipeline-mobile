import { afterEach, describe, expect, it, vi } from "vitest";
import { generationCanvasSize, imageUsageCostUsd, OpenAIImageProvider } from "@/adapters/image/openai";

const tracked = ["IMAGE_API_KEY", "IMAGE_BASE_URL", "IMAGE_MODEL", "OPENAI_API_KEY", "OPENAI_BASE_URL",
  "OPENAI_IMAGE_MODEL", "OPENAI_IMAGE_QUALITY", "OPENAI_IMAGE_ESTIMATED_COST_CHF"] as const;
const original = Object.fromEntries(tracked.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of tracked) {
    if (original[key] == null) delete process.env[key];
    else process.env[key] = original[key];
  }
  vi.unstubAllGlobals();
});

describe("GPT Image 2.5 generation and print sizing", () => {
  it("matches product-shaped dimensions to 16px custom-size policy", () => {
    expect(generationCanvasSize({ width: 1152, height: 1392, aspectRatio: "4:5" }, "gpt-image-2.5-flare")).toBe("1152x1392");
    expect(generationCanvasSize({ width: 1924, height: 806, aspectRatio: "16:9" }, "gpt-image-2.5-sunburst")).toBe("1920x800");
    expect(generationCanvasSize({ width: 1216, height: 1824 }, "gpt-image-2.5-flare-2026-09-08")).toBe("1216x1824");
  });

  it("uses standard canvas sizes for older image providers or invalid custom sizes", () => {
    expect(generationCanvasSize({ width: 1216, height: 1824, aspectRatio: "2:3" }, "gpt-image-1.5")).toBe("1024x1536");
    expect(generationCanvasSize({ width: 100, height: 100, aspectRatio: "1:1" }, "gpt-image-2.5-flare")).toBe("1024x1024");
    expect(generationCanvasSize({ width: 5600, height: 800, aspectRatio: "16:9" }, "gpt-image-2.5-flare")).toBe("1536x1024");
  });

  it("calculates token costs when the official API supplies usage", () => {
    expect(imageUsageCostUsd({ input_tokens: 500, output_tokens: 9000 }, "gpt-image-2.5-flare")).toBeCloseTo(0.2725);
    expect(imageUsageCostUsd({ cost: 0.18, output_tokens: 9000 }, "gpt-image-2.5-flare")).toBe(0.18);
    expect(imageUsageCostUsd({ input_tokens: 10 }, "gpt-image-2.5-flare")).toBeUndefined();
  });

  it("sends official quality, opaque background and product-specific dimensions", async () => {
    process.env.IMAGE_BASE_URL = "https://api.openai.com/v1/";
    process.env.IMAGE_API_KEY = "sk-unit";
    process.env.IMAGE_MODEL = "gpt-image-2.5-flare";
    process.env.OPENAI_IMAGE_QUALITY = "xhigh";
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, json: async () => ({ data: [{ b64_json: "abc" }], usage: { input_tokens: 500, output_tokens: 9000 } }) };
    }));
    const result = await new OpenAIImageProvider().generate({
      niche: "alpine", prompt: "mountain lake", seed: 1, width: 1152, height: 1392, aspectRatio: "4:5", print: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "https://api.openai.com/v1/images/generations",
      body: { model: "gpt-image-2.5-flare", quality: "xhigh", background: "opaque",
        output_format: "png", size: "1152x1392", n: 1 },
    });
    expect(result.url).toBe("data:image/png;base64,abc");
    expect(result.costChf).toBeCloseTo(0.2725);
    expect(result.provider).toBe("openai");
  });

  it("stops after OpenRouter 429 instead of submitting a possibly duplicated charge", async () => {
    process.env.IMAGE_API_KEY = "or-unit";
    process.env.IMAGE_BASE_URL = "https://openrouter.ai/api/v1";
    process.env.IMAGE_MODEL = "google/gemini-2.5-flash-image";
    const fetcher = vi.fn(async () => ({
      ok: false,
      status: 429,
      text: async () => "rate limited",
    }));
    vi.stubGlobal("fetch", fetcher);
    await expect(new OpenAIImageProvider().generate({
      niche: "gothic", prompt: "dark flowers", seed: 2,
    })).rejects.toThrow(/429/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reserves a conservative configurable estimate ahead of paid calls", () => {
    process.env.IMAGE_BASE_URL = "https://api.openai.com/v1";
    process.env.IMAGE_MODEL = "gpt-image-2.5-flare";
    delete process.env.OPENAI_IMAGE_ESTIMATED_COST_CHF;
    expect(new OpenAIImageProvider().estimatedCostChf).toBe(0.5);
    process.env.OPENAI_IMAGE_ESTIMATED_COST_CHF = "0.8";
    expect(new OpenAIImageProvider().estimatedCostChf).toBe(0.8);
  });
});
