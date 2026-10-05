import { describe, expect, it } from "vitest";
import { normalizeEtsyVolume, scoreKeyword } from "@/lib/niches";
import { localAssetPng, podMockupPng } from "@/lib/png";
import { parseEtsyInsights, preferMeasuredDemand, signalToCandidate } from "@/pipeline/etsy-demand";
import { listingImageForProduct, printArtworkUrl } from "@/pipeline/mockup";
import type { KeywordCandidate } from "@/pipeline/sources";

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

describe("POD mockups", () => {
  it("draws a PNG product scene for mugs and posters", () => {
    const mug = podMockupPng("mug", "christmas");
    const poster = podMockupPng("posterA3", "gothic");
    expect(mug.subarray(0, 8)).toEqual(PNG);
    expect(poster.subarray(0, 8)).toEqual(PNG);
    expect(poster.equals(mug)).toBe(false);
    const fromUrl = localAssetPng("https://shop.example/api/mockup/mug?niche=christmas");
    expect(fromUrl?.subarray(0, 8)).toEqual(PNG);
    expect(localAssetPng("https://cdn.example/design.png")).toBeNull();
    expect(podMockupPng("tshirt", "alpine").equals(podMockupPng("sweatshirt", "alpine"))).toBe(false);
  });

  it("uses a mockup URL for POD and keeps digital artwork", async () => {
    const art = "/api/placeholder/7?niche=christmas";
    const pod = await listingImageForProduct({ productType: "pod", artworkUrl: art, preset: "mug", niche: "christmas" });
    expect(pod.mocked).toBe(true);
    expect(pod.url).toBe("/api/mockup/mug?niche=christmas");
    expect(pod.provider).toBe("template-mockup");
    const poster = await listingImageForProduct({ productType: "pod", artworkUrl: art, preset: "posterA3", niche: "gothic" });
    expect(poster.url).toContain("/api/mockup/posterA3");
    const digital = await listingImageForProduct({ productType: "digital", artworkUrl: art, niche: "birthday" });
    expect(digital).toEqual({ url: art, provider: "artwork", mocked: false });
  });

  it("sends the design file to print, not the mockup", () => {
    expect(printArtworkUrl("/api/mockup/mug?niche=christmas", "/api/placeholder/7")).toBe("/api/placeholder/7");
    expect(printArtworkUrl("/api/mockup/mug?niche=christmas", null)).toBe("/api/mockup/mug?niche=christmas");
  });
});

describe("Etsy demand signals", () => {
  const csv = `keyword,search_volume,competition,niche
cozy christmas mug,8400,0.62,christmas
# ignored
swiss alps wall art,100,0.45,alpine
`;

  it("parses a Marketplace Insights-style CSV", () => {
    const rows = parseEtsyInsights(csv);
    expect(rows).toEqual([
      { phrase: "cozy christmas mug", searchVolume: 8400, competition: 0.62, niche: "christmas" },
      { phrase: "swiss alps wall art", searchVolume: 100, competition: 0.45, niche: "alpine" },
    ]);
  });

  it("prefers measured volume over a seed heuristic and over Google Trends", () => {
    const seed: KeywordCandidate = {
      phrase: "cozy christmas mug",
      niche: "christmas",
      source: "seed-list",
      demand: 0.2,
      competition: 0.9,
    };
    const measured = signalToCandidate({ phrase: "cozy christmas mug", searchVolume: 10000, competition: 0.4, niche: "christmas" });
    const [winner] = preferMeasuredDemand([seed, measured]);
    expect(winner.source).toBe("etsy-insights");
    expect(winner.searchVolume).toBe(10000);
    expect(winner.demand).toBe(normalizeEtsyVolume(10000));

    const withVolume = scoreKeyword({ demand: 0.2, competition: 0.4, seasonality: 0.6, trend: 0.05, searchVolume: 10000 });
    const trendsOnly = scoreKeyword({ demand: 0.2, competition: 0.4, seasonality: 0.6, trend: 0.05 });
    const fromVolume = scoreKeyword({ demand: normalizeEtsyVolume(10000), competition: 0.4, seasonality: 0.6 });
    expect(withVolume).toBe(fromVolume);
    expect(withVolume).not.toBe(trendsOnly);
    expect(normalizeEtsyVolume(10000)).toBe(0.8);
  });
});
