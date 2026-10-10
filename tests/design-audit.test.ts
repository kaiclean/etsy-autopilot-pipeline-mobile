import { describe, expect, it } from "vitest";
import { buildPrompt, chooseConcept } from "@/pipeline/design";
import { assessArtwork, PRINT_WIDTH, PRINT_HEIGHT } from "@/lib/design-quality";
import { buildProductTitle } from "@/lib/product-title";
import { preparePrintFile } from "@/pipeline/artwork";
import { rgbPng } from "@/lib/png";
import { draftListing } from "@/pipeline/listing";

describe("design audit", () => {
  it("keeps every prompt clean, full bleed and contrast-aware", () => {
    const prompt = buildPrompt("gothic floral shirt", "dark botanical", "gothic");
    expect(prompt).toMatch(/full.bleed/i);
    expect(prompt).toMatch(/high contrast/i);
    expect(prompt).toMatch(/clean edges/i);
    expect(prompt).toMatch(/unframed/i);
    expect(prompt).toMatch(/pictorial rather than typography/i);
  });

  it("avoids recent and same-run concepts across a larger pool", () => {
    const first = chooseConcept("gothic", []);
    expect(first).toBeTruthy();
    const second = chooseConcept("gothic", [first!]);
    expect(second).not.toBe(first);
    expect(chooseConcept("gothic", [first!, second!])).toBeTruthy();
    expect(chooseConcept("gothic", [first!, second!])).not.toBeNull();
    expect(chooseConcept("gothic", [first!.toUpperCase()])).not.toBe(first);
  });

  it("holds artifacts, text and low scores even when dimensions are sufficient", () => {
    expect(assessArtwork({ score: 9, reasons: [], text: true, empty: false, frameOnly: false, artifacts: false }, PRINT_WIDTH, PRINT_HEIGHT).pass).toBe(false);
    expect(assessArtwork({ score: 6, reasons: ["murky"], text: false, empty: false, frameOnly: false, artifacts: false }, PRINT_WIDTH, PRINT_HEIGHT).pass).toBe(false);
    expect(assessArtwork({ score: 9, reasons: [], text: false, empty: false, frameOnly: false, artifacts: false }, 1365, 2048).pass).toBe(false);
    expect(assessArtwork({ score: 8, reasons: [], text: false, empty: false, frameOnly: false, artifacts: false }, PRINT_WIDTH, PRINT_HEIGHT).pass).toBe(true);
  });

  it("keeps native image size while making a compact vision preview", async () => {
    const image = `data:image/png;base64,${rgbPng(4, 6, [80, 90, 100]).toString("base64")}`;
    const prepared = await preparePrintFile(image);
    expect(prepared).toMatchObject({ url: image, width: 4, height: 6 });
    expect(prepared.visionPreview?.length).toBeLessThan(2_000_000);
  });

  it("uses one correct noun and deduplicates sibling copy", () => {
    const title = "Vintage Botanical Engraving in Plum and Burgundy | Vintage Botanical Engraving in Plum and Burgundy Shirt";
    const mug = buildProductTitle("gothic floral shirt", title, "mug");
    expect(mug).toMatch(/^Gothic Floral Mug/i);
    expect(mug).not.toMatch(/shirt|engraving|vintage botanical/i);
    expect(buildProductTitle("gothic floral shirt", title, "posterA3")).toMatch(/^Gothic Floral Poster/i);
    expect(buildProductTitle("gothic floral shirt", title, "tshirt")).toMatch(/^Gothic Floral T-Shirt/i);
    expect(buildProductTitle("gothic floral shirt", title, "sweatshirt")).toMatch(/^Gothic Floral Sweatshirt/i);
    expect(buildProductTitle("gothic floral shirt", title, "digital")).toMatch(/^Gothic Floral Printable Wall Art/i);
    expect(buildProductTitle("shirt", title, "mug")).not.toMatch(/shirt/i);
    expect(buildProductTitle("gothic floral shirt", title.repeat(5), "mug").length).toBeLessThanOrEqual(140);
    const longTail = buildProductTitle("gothic floral shirt", "Gothic Floral Shirt | Moonlit Thorn Garden", "mug");
    expect(longTail).toContain("Moonlit Thorn Garden");
    expect(buildProductTitle("gothic floral shirt", "Gothic Floral Shirt | Moonlit Thorn Garden", "posterA3", [longTail])).not.toContain("Moonlit Thorn Garden");
  });

  it("refills tags after removing unsupported art-style claims", async () => {
    const { draft } = await draftListing({
      niche: "gothic", keyword: "moonlit floral shirt", product: { type: "pod", pod: "mug" },
      seed: 1, assumeOffsiteAds: false, artDirection: "ink botanical in ivory and charcoal",
      llm: {
        name: "test",
        writeListing: async () => ({
          title: "Moonlit Floral Shirt | Thorn Garden Under the Moon",
          tags: ["gothic floral", "vintage engraving", "watercolor print", "mug decor", "botanical illustration",
            "dark botanical", "night garden", "moonlit flower", "witchy floral", "flower gift",
            "dark academia", "rose artwork", "gothic gift"],
          body: "A garden with a moonlit thorn.",
          costChf: 0, provider: "test",
        }),
      },
    });
    expect(draft.tags).toHaveLength(13);
    expect(draft.tags.every((tag) => tag.length <= 20)).toBe(true);
    expect(draft.tags.join(" ")).not.toMatch(/engraving|watercolor|shirt/i);
    expect(draft.title).toContain("Thorn Garden");
  });
});
