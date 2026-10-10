import type { PodPreset } from "@/lib/fees";

const PRODUCT_WORDS = /\b(?:t-?shirts?|shirts?|sweatshirts?|tees?|mugs?|posters?|prints?|printables?|digital|download|wall art)\b/gi;
const NOUN: Record<PodPreset | "digital", string> = {
  digital: "Printable Wall Art",
  posterA3: "Poster",
  mug: "Mug",
  tshirt: "T-Shirt",
  sweatshirt: "Sweatshirt",
};

export function productKeyword(keyword: string) {
  return keyword.replace(PRODUCT_WORDS, " ").replace(/\s+/g, " ").trim();
}

export function buildProductTitle(keyword: string, _copy: string, product: PodPreset | "digital") {
  const lead = productKeyword(keyword) || "Original Art";
  const noun = NOUN[product];
  const limit = 140 - noun.length - 1;
  const clipped = lead.slice(0, limit).trim();
  const trimmed = lead.length > limit ? clipped.replace(/\s+\S*$/, "") || clipped : clipped;
  const name = `${trimmed} ${noun}`.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
  // The source keyword and the actual product, not a hallucinated art style, define the title.
  // The LLM still writes the body and tags; repeated hooks in its title cannot leak into siblings.
  return name.trim();
}
