import type { Niche, ProductType } from "@/db/schema";
import type { PixelSize } from "@/lib/print-targets";

/**
 * Wall-art ratios buyers expect from a finished printable pack.
 * The pipeline does not export these yet: publish uploads one PNG.
 * A later change should resample the artwork to 300 DPI at each ratio and ship a ZIP or PDF.
 */
export const PLANNED_WALL_ART_RATIOS = ["2:3", "3:4", "4:5", "11x14", "ISO A"] as const;

/** Buyer-facing file list. Must match the single file `runPublish` uploads for digital listings. */
function inches(pixels: number, dpi: number) {
  return Number((pixels / dpi).toFixed(1)).toString();
}

export function digitalFileBlurb(format: "png" | "jpeg" | "webp" | null = "png", pixels?: PixelSize | null) {
  const file = format ? `One ${{ png: "PNG", jpeg: "JPEG", webp: "WebP" }[format]} of this artwork` : "One image file of this artwork";
  const dimensions = pixels && pixels.width > 0 && pixels.height > 0
    ? [
      `• Pixel dimensions: ${pixels.width}×${pixels.height}px`,
      `• Largest print at 300 DPI: ${inches(pixels.width, 300)}×${inches(pixels.height, 300)} in`,
      `• Largest print at 150 DPI: ${inches(pixels.width, 150)}×${inches(pixels.height, 150)} in`,
    ]
    : [];
  return ["WHAT YOU GET", `• ${file}`, ...dimensions, "• Instant download after purchase"].join("\n");
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
  /** Set only when the file was exported at a real DPI we can stand behind. */
  dpi: number | null;
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

type PromiseRule = {
  label: string;
  pattern: RegExp;
  allowed: (facts: DeliverableFacts) => boolean;
};

const COUNT_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};
const COUNT_CLAIM = /\b(?:set|bundle|pack|package)s?\s+of\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/gi;

function promisedCounts(text: string) {
  return [...text.matchAll(COUNT_CLAIM)].map((match) => Number(match[1]) || COUNT_WORDS[match[1]!.toLowerCase()]!);
}

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
    pattern: /\bset of(?:\s+\d+|\s+one|\s+two|\s+three|\s+four|\s+five|\s+six|\s+seven|\s+eight|\s+nine|\s+ten)?\b|\b(?:wall|gallery|print|poster|art) set\b/i,
    allowed: (f) => f.fileCount > 1,
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
    if (!rule.pattern.test(text)) continue;
    if (["set", "bundle", "pack", "package"].includes(rule.label) && promisedCounts(text).length) {
      if (promisedCounts(text).some((count) => count > facts.fileCount)) found.push(rule.label);
      continue;
    }
    if (!rule.allowed(facts)) {
      found.push(rule.label);
      continue;
    }
  }
  return found;
}

export function keywordHasUndeliverablePromise(phrase: string, productType: ProductType = "digital") {
  return promiseLabels(phrase, defaultDeliverable(productType)).length > 0;
}

export function removeUndeliverablePromises(text: string, facts: DeliverableFacts) {
  let cleaned = text;
  for (const rule of PROMISE_RULES) {
    if (!rule.pattern.test(cleaned)) continue;
    if (!promiseLabels(cleaned, facts).includes(rule.label)) continue;
    const pattern = rule.label === "set" || ["bundle", "pack", "package"].includes(rule.label)
      ? /\b(?:sets?|bundles?|packs?|packages?)(?:\s+of\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten))?\b/gi
      : new RegExp(rule.pattern.source, "gi");
    cleaned = cleaned.replace(pattern, " ");
  }
  return cleaned
    .replace(/\s+([,.;!?])/g, "$1")
    .replace(/([,;])\s*([,;])/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/^[\s,;|]+|[\s,;|]+$/g, "")
    .trim();
}

/** Safe phrase to put at the start of a title and in the first tag. Never a blocked keyword. */
const LEAD_FALLBACK: Record<Niche, string> = {
  alpine: "swiss alps wall art",
  gothic: "gothic floral art",
  christmas: "cozy christmas art",
  birthday: "birthday party art",
  stream: "neon stream art",
};

export function leadPhrase(phrase: string, niche: Niche, productType: ProductType = "digital") {
  const trimmed = phrase.trim().toLowerCase().replace(/\s+/g, " ");
  if (trimmed && !keywordHasUndeliverablePromise(trimmed, productType)) return trimmed;
  return LEAD_FALLBACK[niche];
}

/**
 * Drop lines that promise files, ratios, or formats the shop does not ship,
 * then state the one image file digital buyers actually get.
 */
export function alignDeliveryCopy(
  body: string,
  productType: ProductType,
  format: "png" | "jpeg" | "webp" | null = "png",
  pixels?: PixelSize | null,
) {
  const facts = defaultDeliverable(productType, format);
  const withoutPack = productType === "digital" ? body.replace(/\n*WHAT YOU GET[\s\S]*$/i, "") : body;
  const kept = withoutPack
    .split("\n")
    .filter((line) => promiseLabels(line, facts).length === 0)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (productType !== "digital") return kept;
  return `${kept}\n\n${digitalFileBlurb(format, pixels)}`.trim();
}
