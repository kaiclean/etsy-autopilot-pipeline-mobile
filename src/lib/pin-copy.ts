import { AI_DISCLOSURE, DIGITAL_DELIVERY_NOTE, PRODUCTION_PARTNER_DISCLOSURE } from "./disclosures";

/** Conservative Pinterest pin limits (title 100, description and alt text 500 characters). */
export const PIN_LIMITS = { title: 100, description: 500, altText: 500 } as const;

/** Short AI note for pins, so buyers arriving from Pinterest see the same honesty as on Etsy. */
export const PIN_AI_NOTE = "Designed with AI image tools from my own prompts.";

export function etsyListingUrl(etsyListingId: string) {
  return `https://www.etsy.com/listing/${encodeURIComponent(etsyListingId)}`;
}

/** Cut to `max` characters on a word boundary, without trailing separators. */
export function clip(text: string, max: number) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max + 1);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : clean.slice(0, max)).replace(/[\s,|\-–:;]+$/, "");
}

const SKIP = [/^WHAT YOU GET/i, (p: string) => p === DIGITAL_DELIVERY_NOTE, (p: string) => p === AI_DISCLOSURE, (p: string) => p === PRODUCTION_PARTNER_DISCLOSURE];

/** First descriptive paragraph of an Etsy description: no file list, delivery note or disclosures. */
export function leadParagraph(description: string) {
  const paras = description.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return paras.find((p) => !SKIP.some((s) => (s instanceof RegExp ? s.test(p) : s(p)))) ?? "";
}

export function buildPinCopy(l: { title: string; description: string; etsyListingId: string }) {
  const lead = leadParagraph(l.description);
  const tail = ` ${PIN_AI_NOTE} Available on Etsy.`;
  const description = clip(lead, PIN_LIMITS.description - tail.length) + tail;
  return {
    title: clip(l.title, PIN_LIMITS.title),
    description: description.trim(),
    link: etsyListingUrl(l.etsyListingId),
    altText: clip(lead || l.title, PIN_LIMITS.altText),
  };
}
