import { describe, expect, it } from "vitest";
import { buildPrompt, chooseConcept } from "@/pipeline/design";
import { assessArtwork, PRINT_WIDTH, PRINT_HEIGHT } from "@/lib/design-quality";
import { buildProductTitle } from "@/lib/product-title";
import { preparePrintFile } from "@/pipeline/artwork";
import { rgbPng } from "@/lib/png";

describe("design audit", () => {
  it("keeps every prompt clean, full bleed and contrast-aware", () => {
    const prompt = buildPrompt("gothic floral shirt", "dark botanical", "gothic");
    expect(prompt).toMatch(/full.bleed/i);
    expect(prompt).toMatch(/high contrast/i);
    expect(prompt).toMatch(/signature/i);
    expect(prompt).toMatch(/frame/i);
    expect(prompt).toMatch(/without text/i);
  });

  it("avoids recent and same-run concepts and exhausts duplicates", () => {
    const first = chooseConcept("gothic", []);
    expect(first).toBeTruthy();
    const second = chooseConcept("gothic", [first!]);
    expect(second).not.toBe(first);
    expect(chooseConcept("gothic", [first!, second!])).toBeTruthy();
    expect(chooseConcept("gothic", ["ink botanical in ivory and charcoal", "moonlit herbarium in teal and copper", "wildflower silhouette in ochre and midnight", "thorn and moth study in indigo and silver"])).toBeNull();
  });

  it("holds artifacts, text and low scores even when dimensions are sufficient", () => {
    expect(assessArtwork({ score: 9, reasons: [], text: true, empty: false, frameOnly: false, artifacts: false }, PRINT_WIDTH, PRINT_HEIGHT).pass).toBe(false);
    expect(assessArtwork({ score: 6, reasons: ["murky"], text: false, empty: false, frameOnly: false, artifacts: false }, PRINT_WIDTH, PRINT_HEIGHT).pass).toBe(false);
    expect(assessArtwork({ score: 9, reasons: [], text: false, empty: false, frameOnly: false, artifacts: false }, 1365, 2048).pass).toBe(false);
    expect(assessArtwork({ score: 8, reasons: [], text: false, empty: false, frameOnly: false, artifacts: false }, PRINT_WIDTH, PRINT_HEIGHT).pass).toBe(true);
  });

  it("resamples an undersized non-RunPod PNG into a stored A3 master", async () => {
    const image = `data:image/png;base64,${rgbPng(4, 6, [80, 90, 100]).toString("base64")}`;
    const prepared = await preparePrintFile(image, {
      upload: async (bytes, type) => {
        expect(type).toBe("image/png");
        expect(bytes.readUInt32BE(16)).toBe(PRINT_WIDTH);
        expect(bytes.readUInt32BE(20)).toBe(PRINT_HEIGHT);
        return { url: "https://cdn.example/print.png", key: "print.png", backend: "s3" };
      },
    });
    expect(prepared).toMatchObject({ url: "https://cdn.example/print.png", width: PRINT_WIDTH, height: PRINT_HEIGHT });
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
  });
});
