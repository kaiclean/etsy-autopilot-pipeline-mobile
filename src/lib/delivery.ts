import type { Niche, ProductType } from "@/db/schema";

/**
 * Wall-art ratios buyers expect from a finished printable pack.
 * The pipeline does not export these yet: publish uploads one PNG.
 * A later change should resample the artwork to 300 DPI at each ratio and ship a ZIP or PDF.
 */
export const PLANNED_WALL_ART_RATIOS = ["2:3", "3:4", "4:5", "11x14", "ISO A"] as const;

/** Buyer-facing file list. Must match the single PNG `runPublish` uploads for digital listings. */
export const DIGITAL_FILE_BLURB = [
  "WHAT YOU GET",
  "• One PNG of this artwork",
  "• Instant download after purchase",
].join("\n");

/** What this pipeline can actually hand a buyer today. */
export type DeliverableFacts = {
  /** Files the buyer downloads. POD is 0. */
  fileCount: number;
  /** Physical units in the order. A single mug or a single PNG is 1. */
  itemCount: number;
  format: "png" | "svg" | "zip" | "pdf";
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

export function defaultDeliverable(productType: ProductType): DeliverableFacts {
  return {
    fileCount: productType === "digital" ? 1 : 0,
    itemCount: 1,
    format: "png",
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

export function leadPhrase(phrase: string, niche: Niche, productType: ProductType = "digital") {
  const trimmed = phrase.trim().toLowerCase().replace(/\s+/g, " ");
  if (trimmed && !keywordHasUndeliverablePromise(trimmed, productType)) return trimmed;
  return LEAD_FALLBACK[niche];
}

/**
 * Drop lines that promise files, ratios, or formats the shop does not ship,
 * then state the one PNG digital buyers actually get.
 */
export function alignDeliveryCopy(body: string, productType: ProductType) {
  const facts = defaultDeliverable(productType);
  const withoutPack = productType === "digital" ? body.replace(/\n*WHAT YOU GET[\s\S]*$/i, "") : body;
  const kept = withoutPack
    .split("\n")
    .filter((line) => promiseLabels(line, facts).length === 0)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (productType !== "digital") return kept;
  return `${kept}\n\n${DIGITAL_FILE_BLURB}`.trim();
}
