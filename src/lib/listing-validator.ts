import type { ValidationIssue } from "@/db/schema";
import { requiredDisclosures } from "./disclosures";

export const ETSY_LIMITS = {
  titleMax: 140,
  tagCount: 13,
  tagMax: 20,
  maxAllCapsWords: 3,
  descriptionMin: 160,
  priceMinChf: 0.2,
} as const;

/** Terms that are trademarked / high-risk on Etsy. Matched case-insensitively on word boundaries. */
export const TRADEMARK_BLOCKLIST = [
  "pokemon",
  "pikachu",
  "spiderman",
  "spider-man",
  "sonic",
  "disney",
  "marvel",
  "mickey",
  "minnie",
  "harry potter",
  "hogwarts",
  "star wars",
  "barbie",
  "bluey",
  "taylor swift",
  "nintendo",
  "mario",
  "hello kitty",
  "nike",
  "grinch",
];

// Etsy titles: letters, numbers, whitespace and common punctuation. %, : and & may appear at most once.
const TITLE_ALLOWED = /^[\p{L}\p{N}\s\-'",.!?|/()+#%:&™©®]+$/u;
const TAG_ALLOWED = /^[\p{L}\p{N} '\-]+$/u;

export type ListingDraft = {
  title: string;
  tags: string[];
  description: string;
  priceChf: number;
  productType: "digital" | "pod";
};

function findTrademarks(text: string) {
  const lower = text.toLowerCase();
  return TRADEMARK_BLOCKLIST.filter((term) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, "u").test(lower);
  });
}

export function validateListing(d: ListingDraft): { valid: boolean; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const push = (i: ValidationIssue) => issues.push(i);
  const title = d.title ?? "";

  if (title.trim().length === 0) {
    push({ field: "title", severity: "error", code: "title_empty", message: "Title is required." });
  }
  if (title.length > ETSY_LIMITS.titleMax) {
    push({
      field: "title",
      severity: "error",
      code: "title_too_long",
      message: `Title is ${title.length} characters; Etsy allows ${ETSY_LIMITS.titleMax}.`,
    });
  }
  if (title && !TITLE_ALLOWED.test(title)) {
    push({ field: "title", severity: "error", code: "title_chars", message: "Title contains characters Etsy does not allow." });
  }
  for (const ch of ["%", ":", "&"]) {
    if (title.split(ch).length - 1 > 1) {
      push({ field: "title", severity: "error", code: "title_repeat_symbol", message: `“${ch}” may only be used once in a title.` });
    }
  }
  const capsWords = title.split(/\s+/).filter((w) => w.length > 1 && /\p{L}/u.test(w) && w === w.toUpperCase());
  if (capsWords.length > ETSY_LIMITS.maxAllCapsWords) {
    push({
      field: "title",
      severity: "error",
      code: "title_caps",
      message: `Etsy allows at most ${ETSY_LIMITS.maxAllCapsWords} all-caps words (found ${capsWords.length}).`,
    });
  }

  const tags = d.tags ?? [];
  if (tags.length !== ETSY_LIMITS.tagCount) {
    push({
      field: "tags",
      severity: "error",
      code: tags.length > ETSY_LIMITS.tagCount ? "tags_too_many" : "tags_too_few",
      message: `Use exactly ${ETSY_LIMITS.tagCount} tags (currently ${tags.length}).`,
    });
  }
  const seen = new Set<string>();
  tags.forEach((tag) => {
    const norm = tag.trim().toLowerCase();
    if (!norm) {
      push({ field: "tags", severity: "error", code: "tag_empty", message: "Tags cannot be empty." });
      return;
    }
    if (tag.length > ETSY_LIMITS.tagMax) {
      push({
        field: "tags",
        severity: "error",
        code: "tag_too_long",
        message: `“${tag}” is ${tag.length} characters; max ${ETSY_LIMITS.tagMax}.`,
      });
    }
    if (!TAG_ALLOWED.test(tag)) {
      push({ field: "tags", severity: "error", code: "tag_chars", message: `“${tag}” may only use letters, numbers, spaces, - and '.` });
    }
    if (seen.has(norm)) {
      push({ field: "tags", severity: "error", code: "tag_duplicate", message: `Duplicate tag “${tag}”.` });
    }
    seen.add(norm);
  });

  const description = d.description ?? "";
  if (description.length < ETSY_LIMITS.descriptionMin) {
    push({ field: "description", severity: "warning", code: "description_short", message: "Description is short; aim for 160+ characters." });
  }
  for (const disclosure of requiredDisclosures(d.productType)) {
    if (!description.includes(disclosure)) {
      const isAi = disclosure.startsWith("Artwork note");
      push({
        field: "description",
        severity: "error",
        code: isAi ? "missing_ai_disclosure" : "missing_partner_disclosure",
        message: isAi
          ? "Missing AI-use disclosure (required by Etsy Creativity Standards)."
          : "Missing production-partner disclosure (required for POD).",
      });
    }
  }

  const tm = findTrademarks([title, ...tags, description].join(" \n "));
  if (tm.length) {
    push({
      field: "title",
      severity: "error",
      code: "trademark",
      message: `Contains trademarked term(s): ${tm.join(", ")}.`,
    });
  }

  if (!(d.priceChf >= ETSY_LIMITS.priceMinChf)) {
    push({ field: "price", severity: "error", code: "price_low", message: "Price must be at least CHF 0.20." });
  }

  return { valid: !issues.some((i) => i.severity === "error"), issues };
}

/** Best-effort repair of LLM output before validation: trims, dedupes, truncates on word boundaries. */
export function sanitizeDraft<T extends ListingDraft>(d: T): T {
  let title = d.title.replace(/\s+/g, " ").trim();
  if (title.length > ETSY_LIMITS.titleMax) {
    title = title.slice(0, ETSY_LIMITS.titleMax);
    const cut = title.lastIndexOf(" ");
    if (cut > 100) title = title.slice(0, cut);
    title = title.replace(/[\s,|\-]+$/, "");
  }
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of d.tags) {
    let t = raw.replace(/[^\p{L}\p{N} '\-]/gu, " ").replace(/\s+/g, " ").trim().toLowerCase();
    if (t.length > ETSY_LIMITS.tagMax) {
      t = t.slice(0, ETSY_LIMITS.tagMax);
      const cut = t.lastIndexOf(" ");
      if (cut > 8) t = t.slice(0, cut);
      t = t.trim();
    }
    if (t && !seen.has(t)) {
      seen.add(t);
      tags.push(t);
    }
  }
  return { ...d, title, tags: tags.slice(0, ETSY_LIMITS.tagCount) };
}
