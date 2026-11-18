import type { DeliverableFacts } from "./delivery";
import type { ProviderDetails } from "./disclosures";
import type { PodPreset } from "./fees";

export const ETSY_LIMITS = {
  titleMax: 140,
  tagCount: 13,
  tagMax: 20,
  maxAllCapsWords: 3,
  descriptionMin: 160,
  titleWordsMin: 6,
  titleWordsMax: 14,
  primaryWithin: 40,
  /** Never the same 2+-word phrase in more than this many tags (etsy-listing skill). */
  phraseTagMax: 2,
  priceMinChf: 0.2,
} as const;

export type ListingDraft = {
  printFit?: "fill" | "fitted" | null;
  title: string;
  tags: string[];
  description: string;
  priceChf: number;
  productType: "digital" | "pod";
  /** Defaults to one opaque PNG (digital) or one physical blank (POD). */
  deliverable?: DeliverableFacts;
  podPreset?: PodPreset;
  podProvider?: string | null;
  providerDetails?: ProviderDetails | null;
  copyProvenance?: { version: 1; provider: string; inputSha256: string; providerDetails?: ProviderDetails | null } | null;
  fileManifest?: { delivery: { width: number; height: number; format?: "png" | "jpeg" | "webp" } } | null;
  /** The keyword this listing targets. When set, its words must sit in the first ~40 title characters. */
  primaryPhrase?: string | null;
};

/** Empty praise. Blocks in title and tags (etsy-listing skill); a warning in the description. */
export const PRAISE_SOURCE =
  "\\b(?:unique|stunning|beautiful|amazing|gorgeous|perfect|premium|awesome|incredible|wonderful|exquisite|breathtaking|luxurious|luxury|bestseller)s?\\b|\\bgift idea\\b";

export const TAG_STOP = new Set(["for", "the", "and", "with", "from", "your", "this", "that", "you"]);

export const FAMILIES = [
  { family: "mug", pattern: /\bmugs?\b/i, presets: ["mug"] },
  { family: "poster", pattern: /\bposters?\b/i, presets: ["posterA3"] },
  { family: "sweatshirt", pattern: /\bsweatshirts?\b/i, presets: ["sweatshirt"] },
  { family: "shirt", pattern: /\b(?:(?:t[ -]?)?shirts?|tees?)\b/i, presets: ["tshirt"] },
  { family: "tote", pattern: /\btote(?: bags?)?\b/i, presets: ["tote"] },
  { family: "phoneCase", pattern: /\bphone cases?\b/i, presets: ["phoneCase"] },
  { family: "canvas", pattern: /\b(?:canvas|canvases)\b/i, presets: ["canvas"] },
  { family: "sticker", pattern: /\bstickers?\b/i, presets: ["sticker"] },
  { family: "blanket", pattern: /\bblankets?\b/i, presets: ["blanket"] },
  { family: "hoodie", pattern: /\bhoodies?\b/i, presets: ["hoodie"] },
  { family: "ornament", pattern: /\bornaments?\b/i, presets: ["ornament"] },
] as const;
