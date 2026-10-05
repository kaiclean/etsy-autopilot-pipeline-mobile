import { describe, expect, it } from "vitest";
import { MockLLMProvider } from "@/adapters/llm/mock";
import { alignDeliveryCopy } from "@/lib/delivery";
import { normalizeEtsyVolume, scoreKeyword } from "@/lib/niches";
import { localAssetPng, podMockupPng } from "@/lib/png";
import { assertOfficialEtsyApi, createEtsyApiCompetitionSource } from "@/pipeline/etsy-api";
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

  it("keeps seed demand and overlays official API competition", () => {
    const [row] = preferMeasuredDemand([
      { phrase: "cozy christmas mug", niche: "christmas", source: "seed-list", demand: 0.76, competition: 0.2 },
      {
        phrase: "cozy christmas mug",
        niche: "christmas",
        source: "etsy-api-v3",
        demand: 0.5,
        competition: 0.9,
        competitionMeasured: true,
      },
    ]);
    expect(row.demand).toBe(0.76);
    expect(row.competition).toBe(0.9);
    expect(row.source).toBe("seed-list+etsy-api-v3");
  });

  it("reads listing counts from openapi.etsy.com and rejects etsy.com scraping", async () => {
    expect(() => assertOfficialEtsyApi("https://www.etsy.com/search?q=mug")).toThrow(/openapi\.etsy\.com/);
    expect(() => assertOfficialEtsyApi("https://www.etsy.com/api/v3/ajax/bespoke/member/neu/specs/async_search")).toThrow(/Scraping/);
    const source = createEtsyApiCompetitionSource({
      enabled: true,
      apiKey: "key:secret",
      phrases: [{ phrase: "cozy christmas mug", niche: "christmas" }],
      fetchImpl: async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        expect(new URL(url).hostname).toBe("openapi.etsy.com");
        expect(url).toContain("/v3/application/listings/active");
        expect(url).not.toContain("www.etsy.com");
        return new Response(JSON.stringify({ count: 1200 }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });
    const [row] = await source.collect();
    expect(row.competitionMeasured).toBe(true);
    expect(row.competition).toBe(normalizeEtsyVolume(1200));
    expect(row.searchVolume).toBeUndefined();
  });
});

describe("digital delivery copy", () => {
  it("describes the single PNG the shop uploads", async () => {
    const copy = await new MockLLMProvider().writeListing({
      keyword: "swiss alps wall art",
      niche: "alpine",
      productType: "digital",
      seed: 1,
    });
    expect(copy.body).toContain("One PNG of this artwork");
    expect(copy.body).not.toMatch(/300\s*dpi/i);
    expect(copy.body).not.toMatch(/2:3/);
    expect(copy.body).not.toMatch(/11x14/i);
  });

  it("strips a model that promises a multi-ratio 300 DPI pack", () => {
    const body = alignDeliveryCopy(
      "A calm alpine print.\n\nWHAT YOU GET\n• High-resolution files (300 DPI)\n• Sizes: 2:3, 3:4, 4:5, ISO A-series, 11x14\n• Editable Canva template",
      "digital",
    );
    expect(body).not.toMatch(/300\s*dpi/i);
    expect(body).not.toMatch(/2:3|canva|11x14/i);
    expect(body).toContain("One PNG of this artwork");
    expect(alignDeliveryCopy("Printed by our partner.", "pod")).toBe("Printed by our partner.");
  });
});
