import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PrintifyDryRunAdapter } from "@/adapters/printify/dryrun";
import { PrintifyLiveClient } from "@/adapters/printify/client";
import { activeNiches, isNichePaused } from "@/lib/niches";
import { inspectPng } from "@/lib/file-manifest";
import { digitalPreviewPng, placeholderPng } from "@/lib/png";
import { buildPrompt } from "@/pipeline/design";
import { KEYWORD_SOURCES } from "@/pipeline/sources";
import {
  digitalActivationRefusal,
  digitalDraftRefusal,
  LIVE_PROVIDER_PIN_ERROR,
  podEtsyPublishRefusal,
} from "@/lib/publish-gates";
import { NICHES } from "@/lib/niches";

const manifest = {
  delivery: {
    filename: "artwork.png",
    width: 1024,
    height: 1536,
    bytes: 1200,
    sha256: "a".repeat(64),
  },
};

describe("publish gates", () => {
  it("refuses a live digital draft of the mock placeholder and a missing manifest", () => {
    expect(
      digitalDraftRefusal({
        etsyMode: "live",
        imageProvider: "mock",
        designProvider: "openai",
        imageUrl: "/api/preview?niche=alpine",
        deliveryUrl: "/api/placeholder/1",
        manifest,
      }),
    ).toMatch(/mock placeholder/);
    expect(
      digitalDraftRefusal({
        etsyMode: "live",
        imageProvider: "openai",
        designProvider: "mock",
        imageUrl: "/api/preview?niche=alpine",
        deliveryUrl: "/api/placeholder/1",
        manifest: null,
      }),
    ).toMatch(/mock placeholder/);
    expect(
      digitalDraftRefusal({
        etsyMode: "live",
        imageProvider: "openai",
        designProvider: "openai",
        imageUrl: "/api/preview?niche=alpine",
        deliveryUrl: "/api/placeholder/1",
        manifest: null,
      }),
    ).toMatch(/filename, pixel size, bytes, sha256/);
  });

  it("refuses a gallery image that is the delivery file", () => {
    expect(
      digitalDraftRefusal({
        etsyMode: "dry-run",
        imageProvider: "openai",
        designProvider: "openai",
        imageUrl: "/files/full.png",
        deliveryUrl: "/files/full.png",
        manifest,
      }),
    ).toMatch(/full-resolution/);
  });

  it("does not let ETSY_ACTIVATE or a missing human check activate a listing", () => {
    process.env.ETSY_ACTIVATE = "true";
    const blocked = digitalActivationRefusal({
      imageProvider: "openai",
      designProvider: "openai",
      manifest,
      fileVerifiedAt: null,
      etsyListingId: "123",
      imageUrl: "/api/preview?niche=alpine",
      deliveryUrl: "/api/placeholder/1",
    });
    expect(blocked).toMatch(/human/);
    expect(
      digitalActivationRefusal({
        imageProvider: "mock",
        designProvider: "openai",
        manifest,
        fileVerifiedAt: new Date(),
        etsyListingId: "123",
        imageUrl: "/api/preview?niche=alpine",
        deliveryUrl: "/api/placeholder/1",
      }),
    ).toMatch(/mock placeholder/);
    delete process.env.ETSY_ACTIVATE;
  });

  it("allows activation only with a real file, a manifest and a human verification", () => {
    expect(
      digitalActivationRefusal({
        imageProvider: "openai",
        designProvider: "openai",
        manifest,
        fileVerifiedAt: new Date(),
        etsyListingId: "123",
        imageUrl: "/api/preview?niche=alpine",
        deliveryUrl: "/api/placeholder/1",
      }),
    ).toBeNull();
  });

  it("blocks POD publish to Etsy until a sample exists for that blueprint and provider", () => {
    expect(
      podEtsyPublishRefusal({
        blueprintId: 42,
        providerId: 7,
        sampleApprovedAt: null,
        printifyProductId: "pfy-1",
        alreadyPublished: false,
      }),
    ).toMatch(/physical sample/);
    expect(
      podEtsyPublishRefusal({
        blueprintId: 42,
        providerId: 7,
        sampleApprovedAt: new Date(),
        printifyProductId: "pfy-1",
        alreadyPublished: false,
      }),
    ).toBeNull();
  });

  it("does not publish to Etsy from the cron create call", async () => {
    const dry = new PrintifyDryRunAdapter(() => 0.1);
    const created = await dry.createAndPublish({
      title: "Mug",
      description: "A mug",
      tags: ["mug"],
      priceChf: 24.9,
      imageUrl: "https://example.com/art.png",
      preset: "mug",
    });
    expect(dry.calls.map((call) => call.op)).toEqual(["createProduct"]);
    expect(created.blueprintId).toBe(9001);
    await dry.createAndPublish({
      title: "Mug",
      description: "A mug",
      tags: ["mug"],
      priceChf: 24.9,
      imageUrl: "https://example.com/art.png",
      existingProductId: created.productId,
      publishToEtsy: true,
      blueprintId: created.blueprintId,
      printProviderId: created.printProviderId,
    });
    expect(dry.calls.map((call) => call.op)).toContain("publishProduct");
  });

  it("refuses to auto-pick a live Printify provider", async () => {
    process.env.PRINTIFY_SHOP_ID = "shop";
    delete process.env.PRINTIFY_BLUEPRINT_ID;
    delete process.env.PRINTIFY_PRINT_PROVIDER_ID;
    delete process.env.PRINTIFY_VARIANT_IDS;
    const client = new PrintifyLiveClient();
    await expect(
      client.createAndPublish({
        title: "Mug",
        description: "A mug",
        tags: ["mug"],
        priceChf: 24.9,
        imageUrl: "https://example.com/art.png",
        preset: "mug",
      }),
    ).rejects.toThrow(LIVE_PROVIDER_PIN_ERROR);
    delete process.env.PRINTIFY_SHOP_ID;
  });

  it("keeps the cron publisher from activating listings", () => {
    const src = readFileSync(new URL("../src/pipeline/publish.ts", import.meta.url), "utf8");
    expect(src).not.toContain("ETSY_ACTIVATE");
    expect(src).not.toContain("activateListing");
    expect(src).toContain("publishToEtsy: false");
  });
});

describe("paused digital mixes and image style", () => {
  it("pauses birthday and stream and keeps their styles free of file claims", () => {
    expect(isNichePaused("birthday")).toBe(true);
    expect(isNichePaused("stream")).toBe(true);
    expect(activeNiches().map((n) => n.id)).toEqual(["alpine", "gothic", "christmas"]);
    for (const niche of Object.values(NICHES)) {
      expect(niche.style).not.toMatch(/hand lettering|transparent|editable|template/i);
      const prompt = buildPrompt("sample subject", niche.style);
      expect(prompt).toMatch(/without text|no text/i);
      expect(prompt).toMatch(/opaque background/i);
      expect(prompt).not.toMatch(/hand lettering|transparent png/i);
    }
  });

  it("does not emit paused or undeliverable seed phrases", async () => {
    const phrases = (await Promise.all(KEYWORD_SOURCES.map((source) => source.collect()))).flat().map((row) => row.phrase);
    expect(phrases.some((phrase) => /birthday|stream|vtuber|emote/.test(phrase))).toBe(false);
    expect(phrases.some((phrase) => /editable|template|evite|set of 3|ornament|personalized|animated/.test(phrase))).toBe(false);
  });

  it("makes the gallery preview a different PNG from the delivery file", () => {
    const full = placeholderPng("/api/placeholder/7?niche=alpine");
    const preview = digitalPreviewPng("alpine", "/api/placeholder/7?niche=alpine");
    expect(full && preview).toBeTruthy();
    const fullInfo = inspectPng(full!, "artwork.png");
    const previewInfo = inspectPng(preview, "preview.png");
    expect(fullInfo?.width).toBe(800);
    expect(previewInfo?.width).toBe(480);
    expect(previewInfo?.sha256).not.toBe(fullInfo?.sha256);
  });
});
