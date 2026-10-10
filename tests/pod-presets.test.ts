import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/mockup/[preset]/route";
import { pickBlueprint, pickVariantIds } from "@/adapters/printify/catalog";
import { DEFAULT_POD_PRESETS, podCostChf, productLabel, type PodPreset } from "@/lib/fees";
import { decodePng, localAssetPng, podMockupPng, rgbPng } from "@/lib/png";
import { quoteLadder } from "@/lib/pricing-ladder";
import { buildProductTitle } from "@/lib/product-title";
import { draftListing, productForPhrase } from "@/pipeline/listing";

// Synthetic catalog fixtures exercise matching; ids are not production catalog pins.
const fixtures: [PodPreset, string, string, string, string][] = [
  ["tote", "Cotton Canvas Tote Bag", "Canvas Bag", '15" x 16" White', "Tote Bag"],
  ["phoneCase", "Tough Phone Case", "Phone Case Wallet", "iPhone 15", "Phone Case"],
  ["canvas", "Matte Stretched Canvas", "Framed Canvas", '12" x 18"', "Canvas"],
  ["sticker", "Kiss-Cut Stickers", "Sticker Sheet", '3" x 3"', "Sticker"],
  ["blanket", "Velveteen Plush Blanket", "Hooded Blanket", '50" x 60"', "Blanket"],
  ["hoodie", "Unisex Hooded Sweatshirt", "Youth Hoodie", "White / M", "Hoodie"],
  ["ornament", "Ceramic Ornament", "Ornament Set", "Round", "Ornament"],
];

describe("additional POD presets", () => {
  it.each(fixtures)("matches the %s catalog fixture and excludes incompatible blueprints", (preset, title, avoid, variant) => {
    expect(pickBlueprint(preset, [{ id: 1, title: avoid }, { id: 2, title }])?.id).toBe(2);
    expect(pickBlueprint(preset, [{ id: 1, title: avoid }])).toBeUndefined();
    expect(pickVariantIds(preset, [{ id: 1, title: "Other" }, { id: 2, title: variant }])).toEqual([2]);
  });

  it.each(fixtures)("uses honest unknown pricing and a product-correct title for %s", (preset, _title, _avoid, _variant, noun) => {
    expect(podCostChf(preset)).toBeNull();
    expect(productLabel("pod", `gelato:${preset}`).toLowerCase()).toContain(noun.toLowerCase());
    const title = buildProductTitle("Alpine Shirt Poster", "Alpine Shirt | Mountain Tee Gift", preset);
    expect(title).toContain(noun);
    if (preset !== "hoodie") expect(title).not.toMatch(/\bshirt|tee\b/i);
    expect(title.length).toBeLessThanOrEqual(140);
  });

  it.each(fixtures)("composes a distinct %s mockup and serves it as PNG", async (preset) => {
    const art = decodePng(rgbPng(30, 40, [20, 120, 210]))!;
    const blank = podMockupPng(preset, "alpine");
    const composed = podMockupPng(preset, "alpine", art);
    expect(composed.equals(blank)).toBe(false);
    expect(blank.equals(podMockupPng("posterA3", "alpine"))).toBe(false);
    expect(localAssetPng(`/api/mockup/${preset}`)).not.toBeNull();
    const response = await GET(new Request(`http://localhost/api/mockup/${preset}`), { params: Promise.resolve({ preset }) });
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(decodePng(Buffer.from(await response.arrayBuffer()))?.width).toBe(480);
  });

  it("keeps the current six default listings and excludes unverified costs", () => {
    expect(quoteLadder("alpine").map((rung) => rung.id)).toEqual(["digital-entry", "digital-mid", "poster", "mug", "tee", "sweatshirt"]);
    expect(quoteLadder("alpine", [...DEFAULT_POD_PRESETS, "tote"])).toHaveLength(6);
    expect(quoteLadder("alpine", ["tote"], { tote: 12 }).map((rung) => rung.id)).toEqual(["digital-entry", "digital-mid", "tote"]);
    expect(quoteLadder("alpine", [])).toHaveLength(2);
  });

  it("refuses to draft unverified POD pricing", async () => {
    await expect(draftListing({
      niche: "alpine", keyword: "Mountain", product: { type: "pod", pod: "tote" }, seed: 1,
      assumeOffsiteAds: false, demo: true,
    })).rejects.toThrow("Unverified supplier cost");
  });

  it.each(fixtures)("drafts %s only with a supplied quote and selects explicitly enabled nouns", async (preset, _title, _avoid, _variant, noun) => {
    expect(productForPhrase("alpine", `Mountain ${noun}`, 0, [preset])).toEqual({ type: "pod", pod: preset });
    const result = await draftListing({
      niche: "alpine", keyword: "Mountain Shirt", product: { type: "pod", pod: preset }, seed: 1,
      assumeOffsiteAds: true, podCostChf: 12, demo: true,
    });
    expect(result.draft.title).toContain(noun);
    expect(result.fees.podCostChf).toBe(12);
  });
});
