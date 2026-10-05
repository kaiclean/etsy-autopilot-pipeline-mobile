import type { ValidationIssue } from "@/db/schema";
import { defaultDeliverable, promiseLabels, type DeliverableFacts } from "./delivery";
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
  /** Defaults to one opaque PNG (digital) or one physical blank (POD). */
  deliverable?: DeliverableFacts;
};

/** Empty praise. Warnings only: they do not block approval. */
const PRAISE_SOURCE =
  "\\b(?:unique|stunning|beautiful|amazing|gorgeous|perfect|premium|awesome|incredible|wonderful|exquisite|breathtaking|luxurious|luxury|bestseller)s?\\b|\\bgift idea\\b";

const TAG_STOP = new Set(["for", "the", "and", "with", "from", "your", "this", "that", "you"]);

function praiseWords(text: string) {
  return [...new Set((text.match(new RegExp(PRAISE_SOURCE, "gi")) ?? []).map((w) => w.toLowerCase()))];
}

function singularize(word: string) {
  const w = word.toLowerCase();
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && /(?:ches|shes|xes|zes|ses)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

function tagStem(tag: string) {
  return tag
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map(singularize)
    .join(" ");
}

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

  const facts = d.deliverable ?? defaultDeliverable(d.productType);
  const promiseOn = (field: ValidationIssue["field"], text: string) => {
    const labels = promiseLabels(text, facts);
    if (!labels.length) return;
    push({
      field,
      severity: "error",
      code: "undeliverable_promise",
      message: `${field === "tags" ? "Tag" : field[0].toUpperCase() + field.slice(1)} promises ${labels.join(", ")} but the deliverable does not include it.`,
    });
  };
  promiseOn("title", title);
  for (const tag of tags) promiseOn("tags", tag);
  promiseOn("description", description);

  for (const [field, text] of [
    ["title", title],
    ["description", description],
  ] as const) {
    const words = praiseWords(text);
    if (words.length) {
      push({
        field,
        severity: "warning",
        code: "empty_praise",
        message: `Drop empty praise (${words.join(", ")}).`,
      });
    }
  }
  const praisedTags = tags.flatMap((tag) => praiseWords(tag));
  if (praisedTags.length) {
    push({
      field: "tags",
      severity: "warning",
      code: "empty_praise",
      message: `Drop empty praise in tags (${[...new Set(praisedTags)].join(", ")}).`,
    });
  }

  const stems = new Map<string, string>();
  for (const tag of tags) {
    const exact = tag.trim().toLowerCase();
    const stem = tagStem(exact);
    const prior = stems.get(stem);
    if (prior && prior !== exact) {
      push({
        field: "tags",
        severity: "warning",
        code: "tag_plural_twin",
        message: `“${prior}” and “${exact}” are the same phrase with a plural. Keep one.`,
      });
    }
    if (!prior) stems.set(stem, exact);
  }

  const wordTags = new Map<string, number>();
  for (const tag of tags) {
    const seenInTag = new Set<string>();
    for (const word of tag.toLowerCase().split(/[^a-z0-9']+/)) {
      if (word.length < 3 || TAG_STOP.has(word) || seenInTag.has(word)) continue;
      seenInTag.add(word);
      wordTags.set(word, (wordTags.get(word) ?? 0) + 1);
    }
  }
  const repeated = [...wordTags.entries()].filter(([, n]) => n >= 4).map(([word, n]) => `${word} (${n})`);
  if (repeated.length) {
    push({
      field: "tags",
      severity: "warning",
      code: "tag_repeated_word",
      message: `The same word is in too many tags: ${repeated.join(", ")}.`,
    });
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
