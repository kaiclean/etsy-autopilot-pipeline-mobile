export const AI_DISCLOSURE =
  "Artwork note: this AI-assisted design was created by me using AI image tools from my own original prompts and art direction, then curated and edited by hand.";

export const PRODUCTION_PARTNER_DISCLOSURE =
  "This item is made to order and shipped by our production partner (Printify).";

export type ProviderDetails = {
  processingMin: number;
  processingMax: number;
  shippingMin: number;
  shippingMax: number;
};

export function validProviderDetails(details: ProviderDetails | null | undefined): details is ProviderDetails {
  return !!details && Object.values(details).length === 4 &&
    [details.processingMin, details.processingMax, details.shippingMin, details.shippingMax]
      .every((days) => Number.isFinite(days) && days >= 0) &&
    details.processingMin <= details.processingMax && details.shippingMin <= details.shippingMax;
}

export function providerTimingBlurb(details: ProviderDetails) {
  if (!validProviderDetails(details)) throw new Error("Verified production-provider timings are required.");
  return `Processing: ${details.processingMin}–${details.processingMax} business days.\nShipping: ${details.shippingMin}–${details.shippingMax} business days.`;
}

export function appendProviderDetails(description: string, details: ProviderDetails) {
  const body = description.replace(/\n*Processing: [^\n]*(?:\nShipping: [^\n]*)?/g, "").trim();
  return `${body}\n\n${providerTimingBlurb(details)}`;
}

export const DIGITAL_DELIVERY_NOTE =
  "This is a digital download: no physical item will be shipped. Your files are available instantly after purchase from your Etsy account.";

export function requiredDisclosures(productType: "digital" | "pod") {
  return productType === "pod" ? [AI_DISCLOSURE, PRODUCTION_PARTNER_DISCLOSURE] : [AI_DISCLOSURE];
}

export function withDisclosures(body: string, productType: "digital" | "pod") {
  const parts = [body.trim()];
  if (productType === "digital") parts.push(DIGITAL_DELIVERY_NOTE);
  parts.push(...requiredDisclosures(productType));
  return parts.join("\n\n");
}
