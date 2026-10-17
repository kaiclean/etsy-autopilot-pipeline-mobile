import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrintifyLiveClient } from "@/adapters/printify/client";
import { coverPlacement, printPlaceholder, providerDetails } from "@/adapters/printify/catalog";
import { listPrintifyCandidates } from "@/adapters/printify/catalog-cli";
import { PrintifyDryRunAdapter } from "@/adapters/printify/dryrun";
import { config, parsePrintifyPresets, resolvePrintifyPin } from "@/lib/config";
import { POD_PRESETS, type PodPreset } from "@/lib/fees";
import { PRINT_TARGETS } from "@/lib/print-targets";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const pin = { blueprintId: 21, printProviderId: 31, variantIds: [41, 42] };
const baseInput = { title: "Mountain mug", description: "An alpine mug", tags: ["mug"], priceChf: 20, imageUrl: "", preset: "mug" as const };
const shipping = {
  profiles: [
    { variant_ids: [41, 42], countries: ["CH"], delivery_time: { min: 3, max: 5 } },
    { variant_ids: [41, 42], countries: ["DE", "FR"], delivery_time: { min: 2, max: 6 } },
  ],
};

function setPins() {
  vi.stubEnv("PRINTIFY_SHOP_ID", "fixture-shop");
  vi.stubEnv("PRINTIFY_PRESETS_JSON", JSON.stringify({ mug: pin }));
  vi.stubEnv("PRINTIFY_PIN_PRESET", "");
  vi.stubEnv("PRINTIFY_BLUEPRINT_ID", "");
  vi.stubEnv("PRINTIFY_PRINT_PROVIDER_ID", "");
  vi.stubEnv("PRINTIFY_VARIANT_IDS", "");
}

async function artwork(width = 3600, height = 1200) {
  const bytes = await sharp({ create: { width, height, channels: 3, background: "#123456" } }).png().toBuffer();
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

function mockCreate(variants: unknown = {
  variants: [
    { id: 41, title: "White / 11oz", placeholders: [{ position: "wrap", width: 2700, height: 1100 }] },
    { id: 42, title: "Black / 11oz", placeholders: [{ position: "wrap", width: 2200, height: 1100 }] },
  ],
}) {
  const calls: { path: string; method: string; body?: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    const method = init.method ?? "GET";
    calls.push({ path, method, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined });
    if (path.endsWith("/variants.json")) return Response.json(variants);
    if (path.endsWith("/uploads/images.json")) return Response.json({ id: "upload-1" });
    if (path.endsWith("/products.json")) return Response.json({ id: "product-1" });
    throw new Error(`Unexpected Printify call: ${method} ${path}`);
  }));
  return calls;
}

describe("preset-specific Printify configuration", () => {
  it("validates pins and rejects unknown presets, malformed JSON, non-integers, duplicates and partial pins", () => {
    expect(parsePrintifyPresets(undefined)).toEqual({});
    expect(parsePrintifyPresets(JSON.stringify({ mug: pin }))).toEqual({ mug: pin });
    for (const invalid of ["{", "[]", "null", '{"poster":{}}', '{"mug":{}}',
      JSON.stringify({ mug: { ...pin, blueprintId: 1.5 } }),
      JSON.stringify({ mug: { ...pin, variantIds: [1, 1] } }),
      JSON.stringify({ mug: { ...pin, variantIds: ["41"] } }),
      JSON.stringify({ mug: { ...pin, variantIds: [] } }),
      JSON.stringify({ mug: { ...pin, other: true } }),
    ]) expect(() => parsePrintifyPresets(invalid)).toThrow(/PRINTIFY|Printify/);
  });

  it("limits legacy pins to posterA3 by default and allows an explicit different preset", () => {
    setPins();
    vi.stubEnv("PRINTIFY_PRESETS_JSON", "");
    vi.stubEnv("PRINTIFY_BLUEPRINT_ID", "11");
    vi.stubEnv("PRINTIFY_PRINT_PROVIDER_ID", "12");
    vi.stubEnv("PRINTIFY_VARIANT_IDS", "13,14");
    expect(resolvePrintifyPin("posterA3")).toEqual({ blueprintId: 11, printProviderId: 12, variantIds: [13, 14] });
    expect(resolvePrintifyPin("mug")).toBeUndefined();
    vi.stubEnv("PRINTIFY_PIN_PRESET", "mug");
    expect(resolvePrintifyPin("posterA3")).toBeUndefined();
    expect(resolvePrintifyPin("mug")?.blueprintId).toBe(11);
    vi.stubEnv("PRINTIFY_PRESETS_JSON", JSON.stringify({ mug: pin }));
    expect(resolvePrintifyPin("mug")).toEqual(pin);
  });

  it("rejects invalid legacy IDs and preset names instead of silently filtering them", () => {
    setPins();
    vi.stubEnv("PRINTIFY_VARIANT_IDS", "1,wat");
    expect(() => resolvePrintifyPin("mug")).toThrow("Invalid legacy Printify pin");
    vi.stubEnv("PRINTIFY_VARIANT_IDS", "");
    vi.stubEnv("PRINTIFY_PIN_PRESET", "unknown");
    expect(() => resolvePrintifyPin("mug")).toThrow("PRINTIFY_PIN_PRESET");
  });

  it("keeps health-readable configuration on malformed JSON while pin resolution fails closed without leaking raw values", () => {
    setPins();
    vi.stubEnv("PRINTIFY_PRESETS_JSON", "sensitive-invalid-json");
    expect(config.printify.pinConfigError).toBe("PRINTIFY_PRESETS_JSON must be a JSON object of preset pins");
    expect(config.printify.presets).toEqual({});
    expect(() => resolvePrintifyPin("mug")).toThrow("PRINTIFY_PRESETS_JSON");
    vi.stubEnv("PRINTIFY_PRESETS_JSON", '{"sensitive-key":{}}');
    expect(config.printify.pinConfigError).not.toContain("sensitive-key");
  });

  it("fails clearly before any request when the requested preset has no pin", async () => {
    setPins();
    vi.stubEnv("PRINTIFY_PRESETS_JSON", "");
    const calls = mockCreate();
    await expect(new PrintifyLiveClient().createAndPublish(baseInput)).rejects.toThrow("No Printify blank pinned for Mug");
    expect(calls).toEqual([]);
  });
});

describe("native-resolution create-only Printify placement", () => {
  it("uses the selected variant dimensions and mug wrap position without publishing", async () => {
    setPins();
    const calls = mockCreate();
    const result = await new PrintifyLiveClient().createAndPublish({ ...baseInput, imageUrl: await artwork() });
    expect(result).toEqual({ productId: "product-1", ...pin });
    expect(calls.map((call) => call.method)).toEqual(["GET", "POST", "POST"]);
    expect(calls.some((call) => call.path.includes("publish"))).toBe(false);
    const upload = calls.find((call) => call.path.endsWith("/uploads/images.json"))!.body!;
    expect(upload.contents).toBeTypeOf("string");
    expect(upload).not.toHaveProperty("url");
    const product = calls.find((call) => call.path.endsWith("/products.json"))!.body!;
    expect(product).toMatchObject({
      blueprint_id: 21, print_provider_id: 31,
      variants: [{ id: 41, price: 2000, is_enabled: true }, { id: 42, price: 2000, is_enabled: true }],
      print_areas: [
        { variant_ids: [41], placeholders: [{ position: "wrap", images: [{ id: "upload-1", x: 0.5, y: 0.5, angle: 0 }] }] },
        { variant_ids: [42], placeholders: [{ position: "wrap", images: [{ id: "upload-1", x: 0.5, y: 0.5, angle: 0 }] }] },
      ],
    });
    const areas = product.print_areas as { placeholders: { images: { scale: number }[] }[] }[];
    expect(areas[0].placeholders[0].images[0].scale).toBeCloseTo(11 / 9);
    expect(areas[1].placeholders[0].images[0].scale).toBeCloseTo(1.5);
  });

  it("rejects decoded artwork under the shared minimum before uploading", async () => {
    setPins();
    const calls = mockCreate();
    await expect(new PrintifyLiveClient().createAndPublish({ ...baseInput, imageUrl: await artwork(2700, 1000) })).rejects.toThrow(`minimum ${PRINT_TARGETS.mug.width}×${PRINT_TARGETS.mug.height}`);
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("rejects corrupt raster bytes, not just their declared dimensions", async () => {
    setPins();
    const calls = mockCreate();
    await expect(new PrintifyLiveClient().createAndPublish({ ...baseInput, imageUrl: "data:image/png;base64,Y29ycnVwdA==" })).rejects.toThrow("could not be decoded");
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("rejects missing pinned variants and missing dimensions before upload", async () => {
    setPins();
    const calls = mockCreate({ variants: [{ id: 41, title: "Mug", placeholders: [{ position: "front" }] }] });
    await expect(new PrintifyLiveClient().createAndPublish(baseInput)).rejects.toThrow("No usable");
    expect(calls).toHaveLength(1);
    mockCreate({ variants: [] });
    await expect(new PrintifyLiveClient().createAndPublish(baseInput)).rejects.toThrow("not in the selected");
  });

  it("does not enlarge artwork to satisfy a larger supplier area", () => {
    expect(() => coverPlacement({ width: 2700, height: 1100 }, { position: "front", width: 2800, height: 1100 })).toThrow("upscaling");
    expect(printPlaceholder("mug", { id: 1, title: "Mug", placeholders: [{ position: "front", width: 2000, height: 1000 }] }).position).toBe("front");
  });
});

describe("supplier timing contract and dry-run fixtures", () => {
  it("reads real provider production and shipping profile timings without writes", async () => {
    setPins();
    const fetcher = vi.fn(async (url: string) => Response.json(url.endsWith("/shipping.json") ? shipping : { production_time: { min: 2, max: 4 } }));
    vi.stubGlobal("fetch", fetcher);
    await expect(new PrintifyLiveClient().getProviderDetails("mug")).resolves.toEqual({ processingMin: 2, processingMax: 4, shippingMin: 2, shippingMax: 6 });
    expect(fetcher.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      "/v1/catalog/print_providers/31.json", "/v1/catalog/blueprints/21/print_providers/31/shipping.json",
    ]);
  });

  it("fails closed for missing production or delivery times, unverified routes and uncovered variants", () => {
    expect(() => providerDetails({}, shipping, [41])).toThrow("production_time");
    const provider = { production_time: { min: 2, max: 4 } };
    expect(() => providerDetails(provider, { profiles: [] }, [41])).toThrow("delivery_time");
    expect(() => providerDetails(provider, shipping, [999])).toThrow("delivery_time");
    expect(() => providerDetails(provider, { profiles: [{ variant_ids: [41], countries: ["REST_OF_THE_WORLD"], delivery_time: { min: 2, max: 5 } }] }, [41])).toThrow("delivery_time");
    expect(() => providerDetails({ production_time: { min: 4, max: 2 } }, shipping, [41])).toThrow("production_time");
  });

  it("uses deterministic distinct per-preset IDs and fixture timings, with create-only calls", async () => {
    const dry = new PrintifyDryRunAdapter(() => 0);
    const ids = [];
    for (const preset of Object.keys(POD_PRESETS) as PodPreset[]) {
      const result = await dry.createAndPublish({ ...baseInput, preset });
      ids.push([result.blueprintId, result.printProviderId, result.variantIds[0]]);
      expect(await dry.getProviderDetails(preset)).toEqual(await dry.getProviderDetails(preset));
    }
    for (let i = 0; i < 3; i++) expect(new Set(ids.map((row) => row[i])).size).toBe(Object.keys(POD_PRESETS).length);
    expect(dry.calls.every((call) => call.op === "createProduct")).toBe(true);
  });

  it("returns three explicitly synthetic fixtures for created/reused demo products but never real products", async () => {
    const dry = new PrintifyDryRunAdapter(() => 0);
    const product = await dry.createAndPublish({ ...baseInput, imageUrl: "https://example.com/art.png" });
    const images = await dry.getProductImages(product.productId);
    expect(images).toHaveLength(3);
    expect(new Set(images.map((image) => image.src)).size).toBe(3);
    expect(images.every((image) => image.source === "synthetic" && image.src.startsWith("/api/mockup/mug?") && image.src.includes("synthetic=true"))).toBe(true);
    const polling = new PrintifyDryRunAdapter();
    await polling.createAndPublish({ ...baseInput, existingProductId: product.productId, publishToEtsy: false });
    expect(await polling.getProductImages(product.productId)).toHaveLength(3);
    expect(await polling.getProductImages("real-product")).toEqual([]);
    expect(await polling.getProductImages("dry-unknown")).toEqual([]);
    expect(polling.calls).toEqual([]);
  });
});

describe("read-only catalog discovery", () => {
  it("ranks verified EU/CH shipping first and reports placeholder sizes and IDs without writes", async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      if (url.endsWith("/blueprints.json")) return Response.json([{ id: 1, title: "Ceramic Mug" }, { id: 2, title: "Poster" }]);
      if (url.endsWith("/print_providers.json")) return Response.json([{ id: 9, title: "Unverified provider" }, { id: 10, title: "EU provider" }]);
      if (url.endsWith("/variants.json")) return Response.json({ variants: [{ id: 41, title: "11oz", placeholders: [{ position: "front", width: 2700, height: 1100 }] }] });
      if (url.includes("/10/shipping.json")) return Response.json(shipping);
      return Response.json({ profiles: [] });
    });
    const candidates = await listPrintifyCandidates("mug", "fixture-token", fetcher as typeof fetch);
    expect(candidates.map((row) => row.printProviderId)).toEqual([10, 9]);
    expect(candidates[0]).toMatchObject({
      blueprintId: 1, printProviderId: 10, variantId: 41, verifiedEuChShipping: true,
      placeholders: [{ position: "front", width: 2700, height: 1100 }],
    });
    expect(candidates[1].verifiedEuChShipping).toBe(false);
    expect(JSON.stringify(candidates)).not.toContain("fixture-token");
    expect(fetcher.mock.calls.every(([, init]) => !init?.body)).toBe(true);
  });
});
