import { describe, it, expect } from "vitest";
import path from "path";
import { parseVault, buildResolver, wikilinksToMarkdown, graphData, sectionOf } from "@/lib/brain/vault";
const v = parseVault(path.join(__dirname, "..", "data", "omnibrain", "vault"));
describe("vault", () => {
  it("loads reels and ideas with frontmatter", () => {
    const reels = v.notes.filter((n) => n.kind === "reel");
    const ideas = v.notes.filter((n) => n.kind === "idea");
    expect(reels.length).toBeGreaterThan(0);
    expect(ideas.length).toBeGreaterThan(0);
    expect(typeof reels[0].data.shortcode).toBe("string");
    expect(typeof reels[0].data.date_posted).toBe("string");
  });
  it("resolves wikilinks and source_reels into graph edges", () => {
    const g = graphData(v);
    expect(g.links.filter((l) => l.kind === "link").length).toBeGreaterThan(0);
    const idea = v.notes.find((n) => n.kind === "idea" && Array.isArray(n.data.source_reels))!;
    expect(idea.links.some((l) => l.startsWith("Reels/"))).toBe(true);
  });
  it("rewrites wikilinks with aliases", () => {
    const r = buildResolver(["Summaries/Reels Index", "Ideas/Foo"]);
    expect(wikilinksToMarkdown("[[Summaries/Reels Index|All]] [[Foo]] [[Missing]]", r)).toBe("[All](/brain/note/Summaries/Reels%20Index) [Foo](/brain/note/Ideas/Foo) *Missing*");
  });
  it("extracts sections", () => {
    expect(sectionOf("## A\nhello\n## B\nx", "A")).toBe("hello");
  });
});
