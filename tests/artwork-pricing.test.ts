import { describe, expect, it } from "vitest";
import { AI_DISCLOSURE, PRODUCTION_PARTNER_DISCLOSURE } from "@/lib/disclosures";
import { calculateFees } from "@/lib/fees";
import { repairTrivialCopy, validateListing } from "@/lib/listing-validator";
import { quoteLadder } from "@/lib/pricing-ladder";
import { colorVariance, decodePng, placeholderPng, podMockupPng, rgbPng } from "@/lib/png";
import { evaluateQualityGate } from "@/lib/quality-gate";
import { podMockupUrl } from "@/pipeline/mockup";

const tags = (words: string[]) => {
  const out = [...words];
  let n = 0;
  while (out.length < 13) {
    out.push(`tag ${n}`);
    n++;
  }
  return out.slice(0, 13);
};

describe("artwork compositing and the art gate", () => {
  it("composites decoded artwork into the mug window and leaves placeholder URLs unadorned", () => {
    const scene = decodePng(placeholderPng("/api/placeholder/3?niche=gothic")!);
    expect(scene).not.toBeNull();
    expect(colorVariance(scene!)).toBeGreaterThan(8);
    const flat = podMockupPng("mug", "gothic");
    const composed = podMockupPng("mug", "gothic", scene);
    expect(Buffer.compare(flat, composed)).not.toBe(0);
    expect(podMockupUrl("mug", "christmas", "/api/placeholder/7?niche=christmas")).toBe("/api/mockup/mug?niche=christmas");
    expect(podMockupUrl("mug", "christmas", "https://cdn.example/art.png")).toContain("src=");
  });

  it("rejects placeholder, flat, and sub-2000px print files", () => {
    const base = {
      title: "Cozy Christmas Ceramic Mug",
      tags: tags(["holiday mug"]),
      description: `${AI_DISCLOSURE}\n\n${PRODUCTION_PARTNER_DISCLOSURE}`,
      priceChf: 23.9,
      productType: "pod" as const,
      podProvider: "printify:mug",
      imageUrl: "/api/mockup/mug?niche=christmas",
    };
    const solid = decodePng(rgbPng(64, 64, [180, 20, 20]))!;
    expect(colorVariance(solid)).toBeLessThan(8);

    const placeholder = evaluateQualityGate({ ...base, artworkUrl: "/api/placeholder/1", printWidth: 800, printHeight: 1000, colorVariance: 20 });
    expect(placeholder.pass).toBe(false);
    expect(placeholder.reasons.map((reason) => reason.code)).toContain("placeholder_art");

    const small = evaluateQualityGate({ ...base, artworkUrl: "https://cdn.example/art.png", printWidth: 1024, printHeight: 1536, colorVariance: 30 });
    expect(small.reasons.map((reason) => reason.code)).toContain("low_res_art");

    const flat = evaluateQualityGate({ ...base, artworkUrl: "https://cdn.example/art.png", printWidth: 2400, printHeight: 3000, colorVariance: colorVariance(solid) });
    expect(flat.reasons.map((reason) => reason.code)).toContain("flat_art");

    const ok = evaluateQualityGate({ ...base, artworkUrl: "https://cdn.example/art.png", printWidth: 3510, printHeight: 5265, colorVariance: 40 });
    expect(ok.pass).toBe(true);
  });
});

describe("title repair", () => {
  it("title-cases shouted words, drops empty praise, and keeps at most 3 all-caps words", () => {
    const repaired = repairTrivialCopy({
      title: "COZY WINTER GIFT FOR GRANDMA HAND-DRAWN CHRISTMAS MUG perfect",
      tags: tags(["christmas mug"]),
      description: "A perfect hygge scene for the season.",
      priceChf: 23.9,
      productType: "pod",
    });
    expect(repaired.fixes).toEqual(expect.arrayContaining(["rewrote all-caps words into title case", "removed empty praise from the title", "removed empty praise from the description"]));
    expect(repaired.draft.title).not.toMatch(/\bperfect\b/i);
    expect(repaired.draft.description).not.toMatch(/\bperfect\b/i);
    const caps = repaired.draft.title.split(/\s+/).filter((word) => word.length > 1 && /\p{L}/u.test(word) && word === word.toUpperCase());
    expect(caps.length).toBeLessThanOrEqual(3);
    expect(validateListing(repaired.draft).issues.map((issue) => issue.code)).not.toContain("title_caps");
  });
});

describe("product ladder", () => {
  it("prices a first-impression digital and POD rungs at about 30% after ads", () => {
    for (const niche of ["alpine", "gothic", "christmas"] as const) {
      const ladder = quoteLadder(niche);
      expect(ladder.map((rung) => rung.id)).toEqual(["digital-entry", "digital-mid", "poster", "mug", "tee", "sweatshirt"]);
      const entry = ladder[0]!;
      const mid = ladder[1]!;
      expect(entry.priceChf).toBeGreaterThanOrEqual(3.9);
      expect(entry.priceChf).toBeLessThanOrEqual(6.9);
      expect(mid.priceChf).toBeGreaterThan(entry.priceChf);
      expect(mid.deliverable).not.toMatch(/bundle|pack|set/i);
      for (const rung of ladder.filter((item) => item.product.type === "pod")) {
        expect(rung.marginPct).toBeGreaterThanOrEqual(29.5);
        expect(rung.netChf).toBeCloseTo(calculateFees({ priceChf: rung.priceChf, podCostChf: rung.podCostChf, offsiteAds: true }).netChf, 2);
      }
    }
    const alpine = quoteLadder("alpine");
    expect(alpine[0]?.priceChf).toBe(5.9);
    const gothic = quoteLadder("gothic");
    expect(gothic[0]?.priceChf).toBe(3.9);
    expect(gothic[1]?.priceChf).toBe(8.9);
  });
});
