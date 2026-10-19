import { describe, it, expect } from "vitest";
import path from "path";
import { clip, rank, searchHref, noteHref, type QDoc } from "@/lib/brain/quicksearch";
import { parseVault, searchIndex } from "@/lib/brain/vault";

describe("clip", () => {
  it("never splits an emoji surrogate pair (regression: React #418 on /reels)", () => {
    const s = "a".repeat(89) + "😂😂";
    const out = clip(s, 90);
    expect(out).toBe("a".repeat(89) + "😂");
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
    for (let n = 1; n < 40; n++) expect(/[\uD800-\uDBFF]$/.test(clip("x😂y☕️🍪z".repeat(5), n))).toBe(false);
  });
});

describe("quick search", () => {
  const docs: QDoc[] = searchIndex(parseVault(path.join(__dirname, "..", "data", "omnibrain", "vault"))).map((d) => ({ ...d }));
  it("finds etsy notes and ranks title hits first", () => {
    const hits = rank(docs, "etsy");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].title.toLowerCase()).toContain("etsy");
  });
  it("requires every term and ignores 1-char queries", () => {
    expect(rank(docs, "e")).toEqual([]);
    expect(rank(docs, "etsy zzzzqqq")).toEqual([]);
  });
  it("builds safe hrefs", () => {
    expect(searchHref(" etsy seo ")).toBe("/brain/search?q=etsy%20seo");
    expect(noteHref("Ideas/Etsy SEO and GEO Optimizer")).toBe("/brain/note/Ideas/Etsy%20SEO%20and%20GEO%20Optimizer");
  });
});
