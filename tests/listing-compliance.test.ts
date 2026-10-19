import { describe, expect, it } from "vitest";
import { alignDeliveryCopy, digitalFileBlurb, leadPhrase, measuredDigitalDeliverable } from "@/lib/delivery";
import { appendProviderDetails, PRODUCTION_PARTNER_DISCLOSURE, withDisclosures } from "@/lib/disclosures";
import { repairTrivialCopy, validateListing, type ListingDraft } from "@/lib/listing-validator";
import { buildProductTitle } from "@/lib/product-title";
import { draftListing } from "@/pipeline/listing";

const providerDetails = { processingMin: 2, processingMax: 4, shippingMin: 5, shippingMax: 9 };
const tags = Array.from({ length: 13 }, (_, index) => `alpine scene ${index}`);
const facts = measuredDigitalDeliverable("jpeg", { width: 2048, height: 3072 });
const digital = (): ListingDraft => ({
  title: "Swiss Alps Printable Wall Art", tags, productType: "digital", priceChf: 8, deliverable: facts,
  description: withDisclosures(digitalFileBlurb("jpeg", facts), "digital"),
});
const pod = (): ListingDraft => ({
  title: "Swiss Alps Mug", tags, productType: "pod", podPreset: "mug", priceChf: 20, providerDetails,
  description: appendProviderDetails(withDisclosures("Alpine mountain design.", "pod"), providerDetails),
});

describe("buyer-facing listing compliance", () => {
  it.each(["mug", "tshirt"] as const)("uses a product-specific alpine fallback for %s", async (preset) => {
    const keyword = leadPhrase("editable template bundle", "alpine", "pod", preset);
    const title = buildProductTitle(keyword, "Swiss Alps Wall Art Print Printable", preset);
    expect(title).toMatch(preset === "mug" ? /^Swiss Alps Mug/ : /^Swiss Alps T-Shirt/);
    expect(title).not.toMatch(/wall art|\bprints?\b|printable/i);
    const result = await draftListing({
      keyword: "editable template bundle", niche: "alpine", product: { type: "pod", pod: preset },
      seed: 1, assumeOffsiteAds: false, demo: true, providerDetails,
    });
    expect(result.draft.title).toMatch(preset === "mug" ? /^Swiss Alps Mug/ : /^Swiss Alps T-Shirt/);
    expect(result.draft.title).not.toMatch(/wall art|\bprints?\b|printable/i);
    expect(result.draft.tags).toHaveLength(13);
    expect(result.draft.title.length).toBeLessThanOrEqual(140);
  });

  it("rejects misleading physical titles but allows poster and canvas titles", () => {
    expect(validateListing(pod()).valid).toBe(true);
    for (const title of ["Swiss Alps Wall Art Mug", "Swiss Alps Print Mug", "Swiss Alps Printable Mug", "Swiss Alps Shirt"]) {
      expect(validateListing({ ...pod(), title }).issues.map((issue) => issue.code)).toContain("variant_mismatch");
    }
    for (const podPreset of ["posterA3", "canvas"] as const) {
      expect(validateListing({ ...pod(), podPreset, title: `Swiss Alps Wall Art Print ${podPreset === "canvas" ? "Canvas" : "Poster"}` })
        .issues.some((issue) => issue.code === "variant_mismatch")).toBe(false);
    }
  });

  it("states actual pixels and mathematically derived print dimensions, not extra exports", () => {
    const draft = digital();
    expect(draft.description).toContain("AI-assisted");
    expect(draft.description).toContain("One JPEG");
    expect(draft.description).toContain("2048 × 3072 pixels");
    expect(draft.description).toContain("300 DPI: up to 6.82 × 10.24 inches");
    expect(validateListing(draft).valid).toBe(true);
    expect(validateListing({ ...draft, description: draft.description.replace("6.82 × 10.24", "20 × 30") }).valid).toBe(false);
    expect(validateListing({ ...draft, description: `${draft.description}\nPrint at 20 x 30 inches.` }).valid).toBe(false);
    expect(validateListing({ ...draft, description: `${draft.description}\nAn additional 600 DPI export.` }).valid).toBe(false);
    expect(validateListing({ ...draft, description: draft.description.replace("JPEG", "PNG") }).valid).toBe(false);
    expect(validateListing({ ...draft, deliverable: undefined }).issues.map((issue) => issue.code)).toContain("missing_delivery_measurements");
    expect(validateListing({ ...draft, deliverable: undefined,
      fileManifest: { delivery: { width: 2048, height: 3072, format: "jpeg" } } }).valid).toBe(true);
  });

  it("retains canonical delivery facts when repairing empty praise", () => {
    const repaired = repairTrivialCopy({ ...digital(), description: `A stunning mountain scene.\n\n${digital().description}` });
    expect(validateListing(repaired.draft).valid).toBe(true);
  });

  it("strips invented model exports and dimensions before adding measured delivery facts", () => {
    const body = alignDeliveryCopy("Landscape art.\nPrint at 20 x 30 inches.\n300 DPI export.\nWHAT YOU GET\nFive PNG files", "digital", "jpeg", facts);
    expect(body).not.toContain("20 x 30");
    expect(body).not.toContain("Five PNG");
    expect(body).toContain("2048 × 3072 pixels");
  });

  it("requires provider-derived processing and shipping and the exact partner disclosure", () => {
    expect(pod().description).toContain("made to order and shipped by our production partner (Printify)");
    expect(pod().description).toContain("Processing: 2–4 business days.\nShipping: 5–9 business days.");
    expect(validateListing({ ...pod(), providerDetails: undefined }).issues.map((issue) => issue.code)).toContain("missing_provider_timings");
    expect(validateListing({ ...pod(), providerDetails: { ...providerDetails, shippingMax: 3 } }).valid).toBe(false);
    expect(validateListing({ ...pod(), description: pod().description.replace(PRODUCTION_PARTNER_DISCLOSURE, "Printed by a partner.") }).valid).toBe(false);
    expect(validateListing({ ...pod(), description: pod().description.replace("5–9", "1–2") }).valid).toBe(false);
  });

  it("validates persisted provider facts without trusting the description alone", () => {
    const persisted = {
      ...pod(), providerDetails: undefined,
      copyProvenance: { version: 1 as const, provider: "test", inputSha256: "a".repeat(64), providerDetails },
    };
    expect(validateListing(persisted).valid).toBe(true);
    expect(validateListing({ ...persisted,
      copyProvenance: { ...persisted.copyProvenance, providerDetails: undefined } }).valid).toBe(false);
  });

  it("holds rather than inventing unknown shipping claims", async () => {
    const result = await draftListing({
      niche: "alpine", keyword: "mountain mug", product: { type: "pod", pod: "mug" },
      seed: 1, assumeOffsiteAds: false, demo: true,
    });
    expect(result.issues.map((issue) => issue.code)).toContain("missing_provider_timings");
    expect(result.draft.description).not.toMatch(/\d+.*(?:days|weeks)/);
  });

  it("drops model-invented delivery estimates before inserting verified provider timings", () => {
    const body = alignDeliveryCopy("Alpine mountain scene.\nShips within 1 day from the nearest facility.\nProcessing takes 48 hours.\nThe download is one PNG.", "pod");
    const description = appendProviderDetails(withDisclosures(body, "pod"), providerDetails);
    expect(description).not.toMatch(/1 day|48 hours|nearest|download/);
    expect(description).toContain("Shipping: 5–9 business days.");
  });

  it("holds digital drafts when the actual artwork has not been measured", async () => {
    const result = await draftListing({
      niche: "alpine", keyword: "mug", product: { type: "digital" },
      seed: 1, assumeOffsiteAds: false, demo: true,
    });
    expect(result.draft.title).toMatch(/^Swiss Alps Printable Wall Art/);
    expect(result.issues.map((issue) => issue.code)).toContain("missing_delivery_measurements");
    expect(result.draft.description).not.toMatch(/DPI|Pixel size/);
  });
});
