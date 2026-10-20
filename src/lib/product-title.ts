import type { PodPreset } from "@/lib/fees";
import { ETSY_LIMITS } from "@/lib/listing-validator";

const PRODUCT_WORDS = /\b(?:tote(?: bags?)?|phone cases?|canvases|canvas|stickers?|blankets?|hoodies?|ornaments?|t[ -]?shirts?|shirts?|sweatshirts?|tees?|mugs?|posters?|prints?|printables?|digital|downloads?|png|svg|jpe?g|pdf|clipart|wall[ -]+art)\b/gi;
const NOUN: Record<PodPreset | "digital", string> = {
  digital: "Printable Wall Art",
  posterA3: "Poster",
  mug: "Mug",
  tshirt: "T-Shirt",
  sweatshirt: "Sweatshirt",
  tote: "Tote Bag",
  phoneCase: "Phone Case",
  canvas: "Canvas",
  sticker: "Sticker",
  blanket: "Blanket",
  hoodie: "Hoodie",
  ornament: "Ornament",
};

export function productKeyword(keyword: string) {
  return keyword.replace(PRODUCT_WORDS, " ").replace(/\s+/g, " ").trim();
}

export function buildProductTitle(keyword: string, copy: string, product: PodPreset | "digital", siblingTitles: readonly string[] = [], artDirection = "") {
  const lead = productKeyword(keyword) || "Original Art";
  const noun = NOUN[product];
  const limit = ETSY_LIMITS.titleMax - noun.length - 1;
  const clipped = lead.slice(0, limit).trim();
  const trimmed = lead.length > limit ? clipped.replace(/\s+\S*$/, "") || clipped : clipped;
  const base = `${trimmed} ${noun}`.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase()).trim();
  const normalized = new Set(siblingTitles.map((title) => title.toLowerCase()));
  const suffix = copy.split(/[|,]/)
    .map((part) => part.replace(PRODUCT_WORDS, " ")
      .replace(/\b(?:engraving|etched|watercolor|oil painting|linocut|photograph|vintage)\b/gi, (word) =>
        artDirection.toLowerCase().includes(word.toLowerCase()) ? word : " ")
      .replace(/\s+/g, " ").trim())
    .find((part) => {
      const value = part.replace(new RegExp(`^${trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"), "").trim();
      return value.length > 4 && !normalized.has(`${base} | ${value}`.toLowerCase()) &&
        !normalized.has(`${base} | ${part}`.toLowerCase()) && !normalized.has(part.toLowerCase()) &&
        !siblingTitles.some((title) => title.toLowerCase().includes(` | ${part.toLowerCase()}`));
    });
  if (!suffix || suffix.toLowerCase() === trimmed.toLowerCase()) return padTitle(base);
  const extra = suffix.toLowerCase().startsWith(trimmed.toLowerCase()) ? suffix.slice(trimmed.length).trim() : suffix;
  const available = ETSY_LIMITS.titleMax - base.length - 3;
  const fitting = extra.slice(0, available).trim().replace(/\s+\S*$/, (tail) => extra.length > available ? "" : tail);
  return padTitle(fitting.length > 4 ? `${base} | ${fitting}` : base);
}

// Each option reads as a whole phrase, so a short pad never leaves a dangling "| Original".
const PADS = ["Illustrated Design", "Illustrated Art Design", "Original Illustrated Art Design", "Original Illustrated Artwork Design Piece"];
/** Etsy-listing skill: 6-14 title words. Pads short generated titles with neutral, true descriptors (no praise). */
export function padTitle(title: string) {
  const count = (t: string) => t.trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  const need = ETSY_LIMITS.titleWordsMin - count(title);
  if (need <= 0) return title;
  const pad = PADS.find((p) => p.split(" ").length >= need) ?? PADS[PADS.length - 1];
  const padded = `${title}${title.includes(" | ") ? " " : " | "}${pad}`.trim();
  return padded.length <= ETSY_LIMITS.titleMax ? padded : title;
}
