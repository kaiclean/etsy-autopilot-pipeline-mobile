import { describe, expect, it } from "vitest";
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
      "Bring the calm of the Swiss Alps into your home with this minimalist printable. High resolution files in five ratios, ready to print at home or at a local print shop.",
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
