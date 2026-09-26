export const AI_DISCLOSURE =
  "Artwork note: this design was created by me using AI image tools from my own original prompts and art direction, then curated and edited by hand.";

export const PRODUCTION_PARTNER_DISCLOSURE =
  "Designed by me in Switzerland and printed on demand by my production partner, who produces and ships your order from the facility closest to you.";

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
