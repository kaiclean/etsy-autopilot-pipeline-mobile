import { describe, expect, it } from "vitest";
import { pickBlueprint, pickProvider, pickVariantIds } from "@/adapters/printify/catalog";
import { describeFetchError } from "@/lib/http-error";
import { placeholderPng, rgbPng } from "@/lib/png";
import { sseFailuresAfterError, SSE_HEALTHY_MS } from "@/lib/realtime";

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

describe("placeholder raster", () => {
  it("builds a PNG Etsy can accept for our own placeholder art", () => {
    const buf = placeholderPng("https://tunnel.example/api/placeholder/12?niche=gothic");
    if (!buf) throw new Error("expected a PNG");
    expect(buf.subarray(0, 8)).toEqual(PNG);
    expect(buf.readUInt32BE(16)).toBeGreaterThanOrEqual(635);
    expect(buf.readUInt32BE(20)).toBeGreaterThanOrEqual(635);
  });

  it("leaves real image URLs to the network", () => {
    expect(placeholderPng("https://cdn.example/design.png")).toBeNull();
    expect(rgbPng(8, 8, [1, 2, 3]).subarray(0, 8)).toEqual(PNG);
  });
});

describe("fetch errors", () => {
  it("includes the cause behind undici's fetch failed", () => {
    const error = new TypeError("fetch failed");
    error.cause = new Error("connect ECONNREFUSED 127.0.0.1:443");
    expect(describeFetchError(error, "Etsy POST /listings").message).toBe(
      "Etsy POST /listings: connect ECONNREFUSED 127.0.0.1:443",
    );
  });

  it("keeps an HTTP error message", () => {
    const error = new Error("Etsy POST /listings → 403: denied");
    expect(describeFetchError(error, "Etsy")).toBe(error);
  });
});

describe("printify catalog", () => {
  const blueprints = [
    { id: 2, title: "Framed Canvas Poster" },
    { id: 9, title: "Matte Poster" },
    { id: 3, title: "Youth T-shirt" },
    { id: 6, title: "Unisex Heavy Cotton Tee" },
    { id: 11, title: "Ceramic Mug 11oz" },
    { id: 14, title: "Unisex Crewneck Sweatshirt" },
  ];

  it("picks a blank that matches the listing preset", () => {
    expect(pickBlueprint("posterA3", blueprints)?.id).toBe(9);
    expect(pickBlueprint("tshirt", blueprints)?.id).toBe(6);
    expect(pickBlueprint("mug", blueprints)?.id).toBe(11);
    expect(pickBlueprint("sweatshirt", blueprints)?.id).toBe(14);
    expect(pickBlueprint("posterA3", [{ id: 1, title: "Hoodie" }])).toBeUndefined();
  });

  it("prefers Printify Choice and a white medium front variant", () => {
    expect(pickProvider([{ id: 1, title: "Monster Digital" }, { id: 99, title: "Printify Choice" }])?.id).toBe(99);
    expect(
      pickVariantIds("tshirt", [
        { id: 1, title: "Black / S", options: { color: "Black", size: "S" }, placeholders: [{ position: "front" }] },
        { id: 2, title: "White / M", options: { color: "White", size: "M" }, placeholders: [{ position: "front" }] },
        { id: 3, title: "White / Back", options: { color: "White", size: "M" }, placeholders: [{ position: "back" }] },
      ]),
    ).toEqual([2]);
  });
});

describe("realtime fallback", () => {
  it("counts a stream that dies immediately and resets after a healthy one", () => {
    expect(sseFailuresAfterError(0, 1_000, 0)).toBe(1);
    expect(sseFailuresAfterError(1_000, 1_500, 1)).toBe(2);
    expect(sseFailuresAfterError(1_000, 1_000 + SSE_HEALTHY_MS, 2)).toBe(0);
  });
});
