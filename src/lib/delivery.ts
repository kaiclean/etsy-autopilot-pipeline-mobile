import type { Niche, ProductType } from "@/db/schema";
import type { PodPreset } from "./fees";

/**
 * Wall-art ratios buyers expect from a finished printable pack.
 * The pipeline does not export these yet: publish uploads one PNG.
 * A later change should resample the artwork to 300 DPI at each ratio and ship a ZIP or PDF.
 */
export const PLANNED_WALL_ART_RATIOS = ["2:3", "3:4", "4:5", "11x14", "ISO A"] as const;

/** Buyer-facing file list. Must match the single file `runPublish` uploads for digital listings. */
export function digitalFileBlurb(format: "png" | "jpeg" | "webp" | null = "png", facts?: DeliverableFacts) {
  const file = format ? `One ${{ png: "PNG", jpeg: "JPEG", webp: "WebP" }[format]} of this artwork` : "One image file of this artwork";
  const measured = facts?.pixels && facts.dpi && facts.sizes.length
    ? [`• Pixel size: ${facts.pixels.width} × ${facts.pixels.height} pixels`,
      `• Print size at ${facts.dpi} DPI: up to ${facts.sizes[0]} (no additional exports included)`]
    : [];
  return ["WHAT YOU GET", `• ${file}`, ...measured, "• Instant download after purchase"].join("\n");
}

export const DIGITAL_FILE_BLURB = digitalFileBlurb();

/** What this pipeline can actually hand a buyer today. */
export type DeliverableFacts = {
  /** Files the buyer downloads. POD is 0. */
  fileCount: number;
  /** Physical units in the order. A single mug or a single image file is 1. */
  itemCount: number;
  format: "png" | "jpeg" | "webp" | "svg" | "zip" | "pdf" | "unknown";
  transparent: boolean;
  animated: boolean;
  editable: boolean;
  personalized: boolean;
  commercialUse: boolean;
  /** Recommended printing density, derived from measured pixels; not an invented export. */
  dpi: number | null;
  pixels?: { width: number; height: number };
  ratios: string[];
  sizes: string[];
  blank: "poster" | "mug" | "shirt" | "sweatshirt" | "ornament" | null;
  includes: Array<"emotes" | "webcam-frame" | "alerts" | "panels">;
};

export function defaultDeliverable(productType: ProductType, format: "png" | "jpeg" | "webp" | null = "png"): DeliverableFacts {
  return {
    fileCount: productType === "digital" ? 1 : 0,
    itemCount: 1,
    format: productType === "digital" ? format ?? "unknown" : "png",
    transparent: false,
    animated: false,
    editable: false,
    personalized: false,
    commercialUse: false,
    dpi: null,
    ratios: [],
    sizes: [],
    blank: null,
    includes: [],
  };
}

export function measuredDigitalDeliverable(
  format: "png" | "jpeg" | "webp" | null,
  pixels?: { width: number; height: number } | null,
): DeliverableFacts {
  const facts = defaultDeliverable("digital", format);
  if (!pixels || !Number.isSafeInteger(pixels.width) || !Number.isSafeInteger(pixels.height) ||
    pixels.width <= 0 || pixels.height <= 0 || !format) return facts;
  const dpi = 300;
  const inches = (value: number) => (Math.floor(value / dpi * 100) / 100).toFixed(2);
  return { ...facts, pixels, dpi, sizes: [`${inches(pixels.width)} × ${inches(pixels.height)} inches`] };
}

type PromiseRule = {
  label: string;
  pattern: RegExp;
  allowed: (facts: DeliverableFacts) => boolean;
};

/**
 * Claims the shop must not make unless `DeliverableFacts` says the file or blank supports them.
 * Checked on title, tags and description for digital and POD.
 */
export const PROMISE_RULES: PromiseRule[] = [
  { label: "editable", pattern: /\beditable\b|\bedit the text\b/i, allowed: (f) => f.editable },
  { label: "template", pattern: /\btemplates?\b|\bcanva\b|\bcorjl\b/i, allowed: (f) => f.editable },
  { label: "evite", pattern: /\bevites?\b/i, allowed: (f) => f.editable },
  {
    label: "set",
    pattern: /\bset of(?: \d+| two| three| four| five)?\b|\b(?:wall|gallery|print|poster|art) set\b/i,
    allowed: (f) => f.itemCount > 1 || f.fileCount > 1,
  },
  { label: "bundle", pattern: /\bbundles?\b/i, allowed: (f) => f.fileCount > 1 },
  { label: "pack", pattern: /\bpacks?\b/i, allowed: (f) => f.fileCount > 1 },
  { label: "package", pattern: /\bpackages?\b/i, allowed: (f) => f.fileCount > 1 },
  { label: "emote", pattern: /\bemotes?\b/i, allowed: (f) => f.includes.includes("emotes") },
  { label: "animated", pattern: /\banimated\b/i, allowed: (f) => f.animated },
  { label: "transparent", pattern: /\btransparent\b/i, allowed: (f) => f.transparent },
  { label: "webcam frame", pattern: /\bwebcam\b/i, allowed: (f) => f.includes.includes("webcam-frame") },
  { label: "alerts", pattern: /\balerts?\b/i, allowed: (f) => f.includes.includes("alerts") },
  { label: "panels", pattern: /\bpanels?\b/i, allowed: (f) => f.includes.includes("panels") },
  { label: "personalized", pattern: /\bpersonal(?:i[sz]ed|i[sz]ation)\b/i, allowed: (f) => f.personalized },
  { label: "ornament", pattern: /\bornaments?\b/i, allowed: (f) => f.blank === "ornament" },
  { label: "SVG", pattern: /\bsvg\b/i, allowed: (f) => f.format === "svg" },
  { label: "PNG", pattern: /\bpng\b/i, allowed: (f) => f.format === "png" },
  { label: "JPEG", pattern: /\b(?:jpe?g)\b/i, allowed: (f) => f.format === "jpeg" },
  { label: "WebP", pattern: /\bwebp\b/i, allowed: (f) => f.format === "webp" },
  { label: "commercial use", pattern: /\bcommercial use\b/i, allowed: (f) => f.commercialUse },
  { label: "DPI", pattern: /\bdpi\b/i, allowed: (f) => f.dpi != null && f.dpi > 0 },
  {
    label: "print ratio",
    pattern: /\b2:3\b|\b3:4\b|\b4:5\b|\b11\s*x\s*14\b|\biso\s*a\d?\b|\bratios?\b/i,
    allowed: (f) => f.ratios.length > 0,
  },
  { label: "size", pattern: /\b\d+\s*(?:inch|inches|cm|mm)\b|\bsizes\b/i, allowed: (f) => f.sizes.length > 0 },
  { label: "ZIP", pattern: /\bzip\b|\bpdf bundle\b/i, allowed: (f) => f.format === "zip" || f.format === "pdf" || f.fileCount > 1 },
];

export function promiseLabels(text: string, facts: DeliverableFacts) {
  const found: string[] = [];
  for (const rule of PROMISE_RULES) {
    if (rule.pattern.test(text) && !rule.allowed(facts)) found.push(rule.label);
  }
  return found;
}

export function keywordHasUndeliverablePromise(phrase: string, productType: ProductType = "digital") {
  return promiseLabels(phrase, defaultDeliverable(productType)).length > 0;
}

/** Safe phrase to put at the start of a title and in the first tag. Never a blocked keyword. */
const LEAD_FALLBACK: Record<Niche, string> = {
  alpine: "swiss alps wall art",
  gothic: "gothic floral art",
  christmas: "cozy christmas art",
  birthday: "birthday party art",
  stream: "neon stream art",
};

export function leadPhrase(phrase: string, niche: Niche, productType: ProductType = "digital", preset?: PodPreset) {
  const trimmed = phrase.trim().toLowerCase().replace(/\s+/g, " ");
  if (trimmed && !keywordHasUndeliverablePromise(trimmed, productType)) return trimmed;
  if (productType === "digital") return LEAD_FALLBACK[niche];
  const nouns: Record<PodPreset, string> = {
    posterA3: "poster", mug: "mug", tshirt: "t-shirt", sweatshirt: "sweatshirt", tote: "tote bag",
    phoneCase: "phone case", canvas: "canvas", sticker: "sticker", blanket: "blanket", hoodie: "hoodie", ornament: "ornament",
  };
  return `${LEAD_FALLBACK[niche].replace(/ wall art$| art$/, "")} ${nouns[preset ?? "posterA3"]}`;
}

/**
 * Drop lines that promise files, ratios, or formats the shop does not ship,
 * then state the one image file digital buyers actually get.
 */
export function alignDeliveryCopy(body: string, productType: ProductType, format: "png" | "jpeg" | "webp" | null = "png", measured?: DeliverableFacts) {
  const facts = defaultDeliverable(productType, format);
  const withoutPack = productType === "digital" ? body.replace(/\n*WHAT YOU GET[\s\S]*$/i, "") : body;
  const kept = withoutPack
    .split("\n")
    .filter((line) => promiseLabels(line, facts).length === 0 &&
      !/\b\d+(?:\.\d+)?\s*(?:×|x)\s*\d+(?:\.\d+)?\s*(?:pixels?|px|inches?|cm|mm)\b/i.test(line) &&
      !(productType === "pod" && /\b(?:days?|weeks?|hours?|closest|nearest|downloads?)\b/i.test(line)))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (productType !== "digital") return kept;
  return `${kept}\n\n${digitalFileBlurb(format, measured)}`.trim();
}
