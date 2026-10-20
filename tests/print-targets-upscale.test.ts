import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { AI_DISCLOSURE, PRODUCTION_PARTNER_DISCLOSURE } from "@/lib/disclosures";
import { PRINT_TARGETS, clearPrintTargetCache, getPrintTarget, hasMinimumPixels } from "@/lib/print-targets";
import { evaluateQualityGate } from "@/lib/quality-gate";
import { rgbPng } from "@/lib/png";
import { setUpscaleSessionForTests, upscaleArtwork, upscaleTiledRgb, type UpscaleSession } from "@/pipeline/upscale";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  clearPrintTargetCache();
  setUpscaleSessionForTests(undefined);
});

describe("print targets", () => {
  it("defines minimum and target pixels for every POD preset and digital rung", () => {
    expect(Object.keys(PRINT_TARGETS)).toHaveLength(13);
    expect(PRINT_TARGETS.posterA3).toEqual({ minW: 3508, minH: 4961, targetW: 3508, targetH: 4961 });
    expect(PRINT_TARGETS.mug.targetW).toBe(2700);
    expect(PRINT_TARGETS.mug.minW).toBe(1200);
    expect(PRINT_TARGETS.tshirt).toEqual({ minW: 3000, minH: 3600, targetW: 4500, targetH: 5400 });
    expect(PRINT_TARGETS.sweatshirt).toEqual(PRINT_TARGETS.tshirt);
    expect(PRINT_TARGETS.digital.minH).toBe(2048);
    expect(PRINT_TARGETS.digitalLarge.minH).toBe(6000);
  });

  it("prefers and caches real Printify placeholder pixels", async () => {
    vi.stubEnv("PRINTIFY_API_TOKEN", "catalog-token");
    vi.stubEnv("PRINTIFY_BLUEPRINT_ID", "");
    vi.stubEnv("PRINTIFY_PRINT_PROVIDER_ID", "");
    vi.stubEnv("PRINTIFY_VARIANT_IDS", "");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/catalog/blueprints.json")) return Response.json([{ id: 1, title: "Poster" }]);
      if (url.endsWith("/print_providers.json")) return Response.json([{ id: 2, title: "Printify Choice" }]);
      return Response.json({ variants: [{ id: 3, title: "A3", placeholders: [{ position: "front", width: 4000, height: 6000 }] }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    // Apparel uses the placeholder but never drops below the static 3000×3600 floor.
    await expect(getPrintTarget("tshirt")).resolves.toMatchObject({
      targetW: 4500, targetH: 6000, minW: 3000, minH: 3960,
    });
    await getPrintTarget("tshirt");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

const tags = Array.from({ length: 13 }, (_, index) => `alpine art ${index}`);

describe("per-product pixel gates", () => {
  it.each([
    ["posterA3", "printify:posterA3", "/api/mockup/posterA3?niche=alpine", "poster"],
    ["mug", "printify:mug", "/api/mockup/mug?niche=alpine", "mug"],
    ["tshirt", "printify:tshirt", "/api/mockup/tshirt?niche=alpine", "tee"],
    ["sweatshirt", "printify:sweatshirt", "/api/mockup/sweatshirt?niche=alpine", "sweatshirt"],
  ] as const)("gates %s against its own minimum pixels", (key, podProvider, imageUrl, noun) => {
    const base = {
      title: `Alpine ${noun} artwork`,
      tags,
      description: `${AI_DISCLOSURE}\n${PRODUCTION_PARTNER_DISCLOSURE}`,
      priceChf: key === "mug" ? 20 : key === "posterA3" ? 20 : 30,
      productType: "pod" as const,
      podProvider,
      imageUrl,
      artworkUrl: "https://cdn.example/design.png",
      colorVariance: 30,
      upscaleMethod: "realesrgan" as const,
    };
    const target = PRINT_TARGETS[key];
    const held = evaluateQualityGate({ ...base, printWidth: 1024, printHeight: 1024 });
    expect(held.reasons.find((reason) => reason.code === "low_res_art")?.message.toLowerCase()).toContain(noun.toLowerCase());
    expect(held.reasons.find((reason) => reason.code === "low_res_art")?.message).toContain("1024×1024px");
    expect(held.reasons.find((reason) => reason.code === "low_res_art")?.message).toContain(`${target.minW}×${target.minH}px`);
    const passing = evaluateQualityGate({ ...base, printWidth: target.targetW, printHeight: target.targetH });
    expect(passing.reasons.map((reason) => reason.code)).not.toContain("low_res_art");
  });

  it("holds apparel/posters after Lanczos-only enlargement but allows mug and standard digital", () => {
    expect(hasMinimumPixels(4500, 5400, PRINT_TARGETS.tshirt)).toBe(true);
    const common = {
      title: "Alpine print",
      tags,
      description: AI_DISCLOSURE,
      priceChf: 20,
      imageUrl: "https://shop.example/api/preview",
      artworkUrl: "https://cdn.example/design.png",
      colorVariance: 30,
      upscaleMethod: "lanczos" as const,
    };
    const poster = evaluateQualityGate({
      ...common, productType: "pod", podProvider: "posterA3", imageUrl: "/api/mockup/posterA3",
      printWidth: 3508, printHeight: 4961,
    });
    expect(poster.reasons.map((reason) => reason.code)).toContain("ai_upscale_required");
    const mug = evaluateQualityGate({
      ...common, productType: "pod", podProvider: "mug", imageUrl: "/api/mockup/mug",
      printWidth: 2700, printHeight: 1120,
    });
    expect(mug.reasons.map((reason) => reason.code)).not.toContain("ai_upscale_required");
    const digital = evaluateQualityGate({
      ...common, productType: "digital", printTargetKey: "digital", printWidth: 1365, printHeight: 2048,
    });
    expect(digital.reasons.map((reason) => reason.code)).not.toContain("ai_upscale_required");
  });
});

describe("upscale stage", () => {
  function session(): UpscaleSession {
    return {
      inputNames: ["input"],
      outputNames: ["output"],
      async run(inputs) {
        const tensor = inputs.input as { dims: number[] };
        const height = tensor.dims[2] * 4;
        const width = tensor.dims[3] * 4;
        return { output: { data: new Float32Array(3 * height * width).fill(0.5), dims: [1, 3, height, width] } };
      },
    };
  }

  it("runs 4x inference in overlapping RGB tiles", async () => {
    const source = { data: new Uint8Array(5 * 3 * 3).fill(80), width: 5, height: 3, channels: 3 };
    const seen: number[][] = [];
    const result = await upscaleTiledRgb(source, session(), 2, 1, (data, dims) => {
      seen.push(dims);
      return { data, dims };
    });
    expect(seen.length).toBeGreaterThan(1);
    expect(result).toMatchObject({ width: 20, height: 12, channels: 3 });
    expect(result.data.every((value) => value === 128)).toBe(true);
  });

  it("falls back to a measured Lanczos PNG with 300 DPI metadata", async () => {
    const source = `data:image/png;base64,${rgbPng(8, 12, [100, 120, 140]).toString("base64")}`;
    const result = await upscaleArtwork(source, {
      minW: 30, minH: 40, targetW: 40, targetH: 60,
    }, {
      fallbackTarget: { minW: 20, minH: 30, targetW: 20, targetH: 30 },
      session: null,
    });
    expect(result).toMatchObject({
      upscaleMethod: "lanczos",
      sourcePx: { width: 8, height: 12 },
      outputPx: { width: 20, height: 30 },
    });
    const bytes = Buffer.from(result.url.split(",")[1]!, "base64");
    expect(await sharp(bytes).metadata()).toMatchObject({ width: 20, height: 30, density: 300, format: "png" });
  });

  it("uses a mocked ONNX session before resizing to the exact target", async () => {
    const source = `data:image/png;base64,${rgbPng(8, 12, [100, 120, 140]).toString("base64")}`;
    const result = await upscaleArtwork(source, {
      minW: 30, minH: 40, targetW: 32, targetH: 48,
    }, { session: session(), createTensor: (data, dims) => ({ data, dims }) });
    expect(result).toMatchObject({
      upscaleMethod: "realesrgan",
      outputPx: { width: 32, height: 48 },
    });
  });
});
