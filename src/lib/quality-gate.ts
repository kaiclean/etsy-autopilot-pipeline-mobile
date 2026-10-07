import type { ProductType, ValidationIssue } from "@/db/schema";
import { AI_DISCLOSURE, PRODUCTION_PARTNER_DISCLOSURE } from "@/lib/disclosures";
import { ETSY_LIMITS } from "@/lib/listing-validator";
import { POD_PRESETS, type PodPreset } from "@/lib/fees";

/**
 * Competitive CHF bands already used by the shop (mug CHF 15–25, A3 poster CHF 18–33).
 * The gate only reads them. It does not choose a price.
 */
const PRICE_BANDS: Partial<Record<PodPreset, readonly [number, number]>> = {
  mug: [15, 25],
  posterA3: [18, 33],
};

const FAMILIES = [
  { family: "mug", pattern: /\bmugs?\b/i, presets: ["mug"] as PodPreset[] },
  { family: "poster", pattern: /\bposters?\b/i, presets: ["posterA3"] as PodPreset[] },
  { family: "sweatshirt", pattern: /\bsweatshirts?\b/i, presets: ["sweatshirt"] as PodPreset[] },
  { family: "shirt", pattern: /\b(?:t-?shirts?|tees?)\b/i, presets: ["tshirt"] as PodPreset[] },
] as const;

export type QualityGateInput = {
  title: string;
  tags: string[];
  description: string;
  priceChf: number;
  productType: ProductType;
  podProvider?: string | null;
  imageUrl?: string | null;
};

export function podPresetFromProvider(provider: string | null | undefined): PodPreset | null {
  const name = provider?.startsWith("printify:") ? provider.slice("printify:".length) : provider ?? "";
  if (name === "posterA3" || name === "mug" || name === "tshirt" || name === "sweatshirt") return name;
  return null;
}

function familiesIn(text: string) {
  return FAMILIES.filter((row) => row.pattern.test(text)).map((row) => row.family);
}

function issue(field: ValidationIssue["field"], code: string, message: string): ValidationIssue {
  return { field, severity: "error", code, message };
}

function mockupOk(imageUrl: string, productType: ProductType, preset: PodPreset | null) {
  const url = imageUrl.trim();
  if (!url) return false;
  if (productType === "digital") return url.includes("/api/preview") || /preview|mockup/i.test(url);
  if (!preset) return /mockup/i.test(url);
  return url.includes(`/api/mockup/${preset}`) || (url.includes(preset) && /mockup/i.test(url));
}

/**
 * Blocks a draft from the approval queue.
 * Passing drafts stay `pending_approval`. Failures keep every reason for the dashboard.
 */
export function evaluateQualityGate(input: QualityGateInput): { pass: boolean; reasons: ValidationIssue[] } {
  const reasons: ValidationIssue[] = [];
  const title = input.title ?? "";
  const tags = input.tags ?? [];
  const description = input.description ?? "";
  const preset = input.productType === "pod" ? podPresetFromProvider(input.podProvider) : null;

  if (title.trim().length === 0) {
    reasons.push(issue("title", "title_empty", "Title is empty."));
  } else if (title.length > ETSY_LIMITS.titleMax) {
    reasons.push(issue("title", "title_too_long", `Title is ${title.length} characters; the maximum is ${ETSY_LIMITS.titleMax}.`));
  }

  if (tags.length !== ETSY_LIMITS.tagCount) {
    reasons.push(issue("tags", "tag_count", `Need exactly ${ETSY_LIMITS.tagCount} tags (found ${tags.length}).`));
  }
  for (const tag of tags) {
    if (tag.length > ETSY_LIMITS.tagMax) {
      reasons.push(issue("tags", "tag_too_long", `“${tag}” is ${tag.length} characters; each tag must be ${ETSY_LIMITS.tagMax} or fewer.`));
    }
  }

  const claimed = new Set(familiesIn(`${title}\n${tags.join("\n")}`));
  const allowed = new Set<string>();
  if (input.productType === "digital") {
    allowed.add("poster");
  } else if (preset) {
    const family = FAMILIES.find((row) => (row.presets as readonly string[]).includes(preset));
    if (family) allowed.add(family.family);
  }
  const conflicts = [...claimed].filter((family) => !allowed.has(family));
  if (conflicts.length) {
    const variant = preset ? (POD_PRESETS[preset]?.label ?? preset) : input.productType === "digital" ? "digital download" : "print";
    reasons.push(
      issue(
        "tags",
        "variant_mismatch",
        `Product is ${variant}, but the title or tags say ${conflicts.join(" and ")}. Mug and poster copy have to match the variant.`,
      ),
    );
  }

  if (preset) {
    const band = PRICE_BANDS[preset];
    if (band && (input.priceChf < band[0] || input.priceChf > band[1])) {
      reasons.push(
        issue(
          "price",
          "price_mismatch",
          `CHF ${input.priceChf.toFixed(2)} is outside the ${POD_PRESETS[preset].label} band (CHF ${band[0].toFixed(0)}–${band[1].toFixed(0)}).`,
        ),
      );
    }
  }

  const hasAi = description.includes(AI_DISCLOSURE) || description.includes("AI image tools");
  if (!hasAi) {
    reasons.push(issue("description", "missing_ai_disclosure", "AI disclosure is missing."));
  }
  if (input.productType === "pod") {
    const hasPartner = description.includes(PRODUCTION_PARTNER_DISCLOSURE) || description.includes("production partner");
    if (!hasPartner) {
      reasons.push(issue("description", "missing_production_disclosure", "Production-partner disclosure is missing."));
    }
  }

  if (!mockupOk(input.imageUrl ?? "", input.productType, preset)) {
    reasons.push(
      issue(
        "image",
        "missing_mockup",
        input.productType === "pod" ? "A product mockup is required before approval." : "A gallery preview is required before approval.",
      ),
    );
  }

  return { pass: reasons.length === 0, reasons };
}
