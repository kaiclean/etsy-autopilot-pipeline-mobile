import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { buildPrompt, chooseConcept, orderDesignQueue, STYLES } from "@/pipeline/design";
import { differenceHash, isNearDuplicate } from "@/lib/design-similarity";

describe("design follows the day's research", () => {
  it("leads the prompt with the selected keyword, not a generic mountain", () => {
    const prompt = buildPrompt("christmas cabin print", "cozy", "christmas", chooseConcept("christmas", [], "christmas cabin print")!);
    expect(prompt.startsWith("Main subject: christmas cabin")).toBe(true);
    expect(prompt).toMatch(/do not substitute a generic mountain/i);
    expect(buildPrompt("swiss travel poster", "x", "alpine")).not.toMatch(/mountain or landscape focal/i);
  });

  it("rotates styles and motifs within a run", () => {
    const run: string[] = [];
    for (let i = 0; i < 4; i++) run.push(chooseConcept("alpine", run, "swiss travel poster")!);
    const styles = run.map((concept) => STYLES.find((style) => concept.startsWith(style)));
    expect(new Set(styles).size).toBe(4);
    expect(new Set(run.map((concept) => concept.split(": ")[1]!.split(" in ")[0])).size).toBe(4);
  });

  it("puts today's selected keywords first and interleaves niches", () => {
    const day = new Date("2026-10-19T00:00:00Z");
    const old = new Date("2026-10-10T00:00:00Z");
    const rows = [
      { id: 1, niche: "alpine", updatedAt: old, score: 99, designFailures: 0 },
      { id: 2, niche: "alpine", updatedAt: old, score: 98, designFailures: 0 },
      { id: 3, niche: "gothic", updatedAt: day, score: 50, designFailures: 0 },
      { id: 4, niche: "christmas", updatedAt: day, score: 40, designFailures: 0 },
      { id: 5, niche: "alpine", updatedAt: day, score: 30, designFailures: 0 },
      { id: 6, niche: "gothic", updatedAt: day, score: 20, designFailures: 0 },
    ];
    expect(orderDesignQueue(rows, day, 4).map((row) => row.id)).toEqual([3, 4, 5, 6]);
  });

  it("flags near-duplicate compositions", async () => {
    const make = (shift: number, color: string) => sharp({ create: { width: 200, height: 300, channels: 3, background: color } })
      .composite([{ input: Buffer.from(`<svg width="200" height="300"><polygon points="${20 + shift},250 100,${60 + shift} 180,250" fill="#222"/></svg>`) }]).png().toBuffer();
    const a = await differenceHash(await make(0, "#9ab"));
    const b = await differenceHash(await make(2, "#9ac"));
    const c = await differenceHash(await sharp({ create: { width: 200, height: 300, channels: 3, background: "#fff" } })
      .composite([{ input: Buffer.from('<svg width="200" height="300"><rect x="0" y="0" width="100" height="150" fill="#000"/><rect x="100" y="150" width="100" height="150" fill="#000"/></svg>') }]).png().toBuffer());
    expect(isNearDuplicate(b, [a])).toBe(true);
    expect(isNearDuplicate(c, [a])).toBe(false);
  });
});

import { capRepeatedTagWords, repairTrivialCopy, validateListing } from "@/lib/listing-validator";

describe("tag writer avoids repeated words", () => {
  it("caps any word at three tags and refills to 13", () => {
    const { tags } = capRepeatedTagWords(["dark art", "dark floral", "dark gothic", "dark academia", "art print", "wall art", "gothic art", "moody art", "art lover"]);
    expect(tags).toHaveLength(13);
    for (const word of ["dark", "art"]) expect(tags.filter((tag) => tag.split(" ").includes(word)).length).toBeLessThanOrEqual(3);
  });

  it("blocks five repeats and repair fixes them", () => {
    const tags = ["art one", "art two", "art three", "art four", "art five", "a1 b", "c1 d", "e1 f", "g1 h", "i1 j", "k1 l", "m1 n", "o1 p"];
    const draft = { title: "Gothic Floral Poster", tags, description: "x", priceChf: 20, productType: "pod" as const };
    expect(validateListing(draft).issues.find((issue) => issue.code === "tag_repeated_word")?.severity).toBe("error");
    expect(repairTrivialCopy(draft).draft.tags.filter((tag) => tag.includes("art")).length).toBeLessThanOrEqual(3);
  });
});
