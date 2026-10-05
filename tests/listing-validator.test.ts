import { describe, expect, it } from "vitest";
import { defaultDeliverable } from "@/lib/delivery";
import { withDisclosures } from "@/lib/disclosures";
import { ETSY_LIMITS, sanitizeDraft, validateListing, type ListingDraft } from "@/lib/listing-validator";

const TAGS = [
  "swiss alps art", "mountain wall art", "alpine decor", "minimalist poster", "nature print",
  "scandi wall art", "switzerland gift", "hiking gift", "cabin decor", "matterhorn",
  "travel poster", "gallery wall", "neutral wall art",
];

function draft(over: Partial<ListingDraft> = {}): ListingDraft {
  const productType = over.productType ?? "digital";
  return {
    title: "Swiss Alps Wall Art Printable, Minimalist Mountain Poster, Alpine Decor",
    tags: [...TAGS],
    description: withDisclosures(
      "Bring the calm of the Swiss Alps into your home with this minimalist printable. One PNG for personal printing at home or at a local print shop.",
      productType,
    ),
    priceChf: 7.9,
    productType,
    ...over,
  };
}

const codes = (d: ListingDraft) => validateListing(d).issues.map((i) => i.code);

describe("validateListing", () => {
  it("accepts a well-formed digital listing", () => {
    const r = validateListing(draft());
    expect(r.valid).toBe(true);
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("accepts a title of exactly 140 characters and rejects 141", () => {
    const base = "Alpine Poster ";
    const t140 = (base.repeat(11) + "x".repeat(140)).slice(0, 140);
    expect(t140.length).toBe(ETSY_LIMITS.titleMax);
    expect(codes(draft({ title: t140 }))).not.toContain("title_too_long");
    expect(codes(draft({ title: t140 + "y" }))).toContain("title_too_long");
  });

  it("requires exactly 13 tags", () => {
    expect(codes(draft({ tags: TAGS.slice(0, 12) }))).toContain("tags_too_few");
    expect(codes(draft({ tags: [...TAGS, "extra tag"] }))).toContain("tags_too_many");
    expect(validateListing(draft({ tags: TAGS.slice(0, 12) })).valid).toBe(false);
  });

  it("accepts a 20-character tag and rejects a 21-character tag", () => {
    const t20 = "a".repeat(10) + " " + "b".repeat(9);
    const t21 = t20 + "c";
    expect(t20.length).toBe(20);
    expect(codes(draft({ tags: [...TAGS.slice(0, 12), t20] }))).not.toContain("tag_too_long");
    expect(codes(draft({ tags: [...TAGS.slice(0, 12), t21] }))).toContain("tag_too_long");
  });

  it("rejects duplicate tags case-insensitively", () => {
    expect(codes(draft({ tags: [...TAGS.slice(0, 12), "Swiss Alps Art"] }))).toContain("tag_duplicate");
  });

  it("rejects disallowed tag characters", () => {
    expect(codes(draft({ tags: [...TAGS.slice(0, 12), "wall art #1"] }))).toContain("tag_chars");
  });

  it("flags trademarked terms anywhere in the listing", () => {
    expect(codes(draft({ title: "Pokemon Birthday Invitation Template" }))).toContain("trademark");
    expect(codes(draft({ tags: [...TAGS.slice(0, 12), "disney party"] }))).toContain("trademark");
    expect(codes(draft({ title: "Supersonic Mountain Art Print" }))).not.toContain("trademark");
  });

  it("requires the AI disclosure", () => {
    expect(codes(draft({ description: "A lovely print with a long enough description ".repeat(5) }))).toContain("missing_ai_disclosure");
  });

  it("requires the production-partner disclosure for POD only", () => {
    const digitalBody = draft().description;
    expect(codes(draft({ productType: "pod", description: digitalBody }))).toContain("missing_partner_disclosure");
    expect(codes(draft({ productType: "pod" }))).not.toContain("missing_partner_disclosure");
    expect(codes(draft())).not.toContain("missing_partner_disclosure");
  });

  it("limits all-caps words and repeated symbols", () => {
    expect(codes(draft({ title: "BIG SALE ALPINE POSTER Print" }))).toContain("title_caps");
    expect(codes(draft({ title: "Alpine & Lake & Forest Print" }))).toContain("title_repeat_symbol");
  });

  it("rejects prices below CHF 0.20", () => {
    expect(codes(draft({ priceChf: 0.1 }))).toContain("price_low");
  });

  it("rejects undeliverable promises in the title, tags and description for digital and POD", () => {
    const promised = "Editable template bundle, set of 3, animated transparent SVG, commercial use, 300 DPI, 2:3";
    for (const productType of ["digital", "pod"] as const) {
      expect(codes(draft({ productType, title: promised }))).toContain("undeliverable_promise");
      expect(codes(draft({ productType, tags: [...TAGS.slice(0, 12), "emote pack"] }))).toContain("undeliverable_promise");
      expect(codes(draft({ productType, description: withDisclosures(promised.repeat(3), productType) }))).toContain("undeliverable_promise");
    }
    expect(codes(draft({ title: "Personalized ornament, webcam frame and stream alerts" }))).toContain("undeliverable_promise");
    expect(codes(draft({ tags: [...TAGS.slice(0, 12), "evite digital"] }))).toContain("undeliverable_promise");
  });

  it("allows a promise word only when the deliverable supports it", () => {
    const editable = draft({
      title: "Editable Birthday Template",
      deliverable: { ...defaultDeliverable("digital"), editable: true },
    });
    expect(codes(editable).filter((code) => code === "undeliverable_promise")).toEqual([]);
  });

  it("warns on empty praise, plural twins and a word repeated across tags", () => {
    const praised = draft({ title: "Unique Gift Idea Alpine Print" });
    const praise = validateListing(praised);
    expect(praise.valid).toBe(true);
    expect(praise.issues.map((i) => i.code)).toContain("empty_praise");

    const twinTags = [...TAGS];
    twinTags[8] = "hiking gifts";
    const twins = draft({ tags: twinTags });
    expect(codes(twins)).toContain("tag_plural_twin");
    expect(validateListing(twins).valid).toBe(true);

    const repeated = draft({
      tags: [
        "alpine wall", "alpine print", "alpine decor", "alpine gift", "nature scene", "scandi art",
        "matterhorn", "travel poster", "cabin decor", "gallery print", "neutral tone", "hiking gift", "swiss lake",
      ],
    });
    expect(codes(repeated)).toContain("tag_repeated_word");
    expect(validateListing(repeated).valid).toBe(true);
  });
});

describe("sanitizeDraft", () => {
  it("truncates long titles on a word boundary and fixes tags", () => {
    const messy = draft({
      title: "Alpine Mountain Poster ".repeat(10),
      tags: ["Swiss Alps Art!!", "swiss alps art", "a very long tag that exceeds twenty", ...TAGS],
    });
    const clean = sanitizeDraft(messy);
    expect(clean.title.length).toBeLessThanOrEqual(ETSY_LIMITS.titleMax);
    expect(clean.title.endsWith(" ")).toBe(false);
    expect(clean.tags.length).toBe(13);
    expect(new Set(clean.tags).size).toBe(clean.tags.length);
    expect(clean.tags.every((t) => t.length <= ETSY_LIMITS.tagMax)).toBe(true);
    expect(validateListing(clean).issues.map((i) => i.field)).not.toContain("tags");
  });
});
