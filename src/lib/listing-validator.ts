import type { ValidationIssue } from "@/db/schema";
import { defaultDeliverable, digitalFileBlurb, measuredDigitalDeliverable, promiseLabels } from "./delivery";
import { providerTimingBlurb, requiredDisclosures, validProviderDetails } from "./disclosures";
import { ETSY_LIMITS, FAMILIES, PRAISE_SOURCE, TAG_STOP, type ListingDraft } from "./listing-rules";

// Limits and the draft type live in listing-rules, repair helpers in listing-repair; re-exported so imports stay stable.
export { ETSY_LIMITS, type ListingDraft } from "./listing-rules";
export { capRepeatedTagWords, repairTrivialCopy, sanitizeDraft } from "./listing-repair";

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

const PRIMARY_STOP = new Set(["for", "the", "and", "with", "a", "an", "of", "to", "in", "on"]);
const stemWord = (w: string) => w.toLowerCase().replace(/(?:ies)$/, "y").replace(/(?:es|s)$/, "");

/** True when every content word of the phrase appears (singular-insensitive) in the first `within` characters of the title. */
export function primaryPhraseUpFront(title: string, phrase: string, within: number = ETSY_LIMITS.primaryWithin) {
  const head = title.slice(0, within + 12).toLowerCase();
  const headWords = new Set(head.split(/[^\p{L}\p{N}']+/u).filter(Boolean).map(stemWord));
  const want = phrase.toLowerCase().split(/\s+/).filter((w) => w && !PRIMARY_STOP.has(w)).map(stemWord);
  return want.length > 0 && want.every((w) => headWords.has(w));
}

/** 2+-word phrases (adjacent word pairs) that appear in more than `max` tags. */
export function overusedTagPhrases(tags: string[], max: number = ETSY_LIMITS.phraseTagMax) {
  const counts = new Map<string, number>();
  for (const tag of tags) {
    const w = tag.toLowerCase().split(/\s+/).filter(Boolean).map(stemWord);
    const pairs = new Set<string>();
    for (let i = 0; i + 1 < w.length; i++) pairs.add(`${w[i]} ${w[i + 1]}`);
    for (const p of pairs) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n > max).map(([p]) => p);
}


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
  const preset = d.podPreset ?? d.podProvider?.split(":").pop();
  if (d.productType === "pod" && preset !== "posterA3" && preset !== "canvas" &&
    /\b(?:wall[ -]+art|prints?|printables?|digital|downloads?)\b/i.test(title)) {
    push({ field: "title", severity: "error", code: "variant_mismatch", message: "Only posters and canvases may use wall-art or print titles for POD." });
  }
  if (d.printFit === "fitted" && /\b(?:full[ -]front|edge[ -]to[ -]edge|all[ -]over)\b/i.test(`${title} ${d.description ?? ""}`)) {
    push({ field: "description", severity: "error", code: "fit_wording", message: "Art is fitted with transparent margins; remove 'full front' / 'edge-to-edge' wording." });
  }
  if (d.productType === "pod" && preset) {
    const matching = FAMILIES.find((family) => (family.presets as readonly string[]).includes(preset));
    if (matching && !matching.pattern.test(title)) {
      push({ field: "title", severity: "error", code: "missing_product_noun", message: "Title must name the physical product being sold." });
    }
    const mismatches = FAMILIES.filter((family) =>
      !(family.presets as readonly string[]).includes(preset) && family.pattern.test(title));
    if (mismatches.length) push({ field: "title", severity: "error", code: "variant_mismatch", message: "Title names a different product variant." });
  }

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
  const titleWords = title.trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  if (title.trim() && (titleWords.length < ETSY_LIMITS.titleWordsMin || titleWords.length > ETSY_LIMITS.titleWordsMax)) {
    push({ field: "title", severity: "error", code: "title_word_count",
      message: `Title has ${titleWords.length} words; use ${ETSY_LIMITS.titleWordsMin}-${ETSY_LIMITS.titleWordsMax}.` });
  }
  if (d.primaryPhrase && title.trim() && !primaryPhraseUpFront(title, d.primaryPhrase)) {
    push({ field: "title", severity: "error", code: "primary_not_first",
      message: `Put the primary buyer phrase “${d.primaryPhrase}” in the first ${ETSY_LIMITS.primaryWithin} characters.` });
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

  const measured = d.fileManifest?.delivery;
  let facts = d.productType === "digital" && measured
    ? measuredDigitalDeliverable(measured.format ?? null, measured)
    : d.deliverable ?? defaultDeliverable(d.productType);
  if (d.productType === "digital" && facts.pixels &&
    (facts.format === "png" || facts.format === "jpeg" || facts.format === "webp")) {
    const derived = measuredDigitalDeliverable(facts.format, facts.pixels);
    facts = { ...facts, pixels: derived.pixels, dpi: derived.dpi, sizes: derived.sizes };
  }
  if (d.productType === "digital") {
    const format = facts.format === "png" || facts.format === "jpeg" || facts.format === "webp" ? facts.format : null;
    if (!facts.pixels || !facts.dpi || !format) {
      push({ field: "description", severity: "error", code: "missing_delivery_measurements", message: "Measured digital file format and pixel dimensions are required." });
    } else if (!description.includes(digitalFileBlurb(format, facts))) {
      push({ field: "description", severity: "error", code: "missing_delivery_details", message: "Description must state the actual file format, pixel dimensions and derived print size at its stated DPI." });
    }
    if (facts.pixels && facts.dpi) {
      const copy = `${title}\n${tags.join("\n")}\n${description}`;
      const falseDpi = [...copy.matchAll(/\b(\d+(?:\.\d+)?)\s*dpi\b/gi)]
        .some((match) => Number(match[1]) !== facts.dpi);
      const falseSize = [...copy.matchAll(/\b(\d+(?:\.\d+)?)\s*[×x]\s*(\d+(?:\.\d+)?)\s*(pixels?|px|inches?|cm|mm)\b/gi)]
        .some((match) => {
          const unit = match[3].toLowerCase();
          const factor = /^(?:pixels?|px)$/.test(unit) ? 1 : facts.dpi! / (unit === "cm" ? 2.54 : unit === "mm" ? 25.4 : 1);
          const actual = [Number(match[1]) * factor, Number(match[2]) * factor].sort((a, b) => a - b);
          const available = [facts.pixels!.width, facts.pixels!.height].sort((a, b) => a - b);
          return actual.some((value, index) => value > available[index] + 0.01);
        });
      if (falseDpi || falseSize) {
        push({ field: "description", severity: "error", code: "undeliverable_promise", message: "Copy claims a print size or DPI that does not match the measured digital file." });
      }
    }
  } else {
    const details = d.providerDetails ?? d.copyProvenance?.providerDetails;
    if (!validProviderDetails(details)) {
      push({ field: "description", severity: "error", code: "missing_provider_timings", message: "Verified production-provider processing and shipping times are required before approval." });
    } else if (!description.includes(providerTimingBlurb(details))) {
      push({ field: "description", severity: "error", code: "missing_provider_timings", message: "Description must state the verified production-provider processing and shipping times." });
    }
  }
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
        severity: field === "title" ? "error" : "warning",
        code: "empty_praise",
        message: `Drop empty praise (${words.join(", ")}).`,
      });
    }
  }
  const praisedTags = tags.flatMap((tag) => praiseWords(tag));
  if (praisedTags.length) {
    push({
      field: "tags",
      severity: "error",
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
      severity: [...wordTags.values()].some((n) => n >= 5) ? "error" : "warning",
      code: "tag_repeated_word",
      message: `The same word is in too many tags: ${repeated.join(", ")}.`,
    });
  }

  const overused = overusedTagPhrases(tags);
  if (overused.length) {
    push({ field: "tags", severity: "warning", code: "tag_phrase_overused",
      message: `The same phrase is in more than ${ETSY_LIMITS.phraseTagMax} tags: ${overused.join(", ")}. Reword some.` });
  }

  const lastWord = title.trim().split(/\s+/).pop()?.replace(/[^A-Za-z]/g, "").toLowerCase() ?? "";
  if (["coffee", "for", "and", "with", "the", "of", "a", "an", "to", "in"].includes(lastWord)) {
    push({ field: "title", severity: "error", code: "title_dangling_word", message: `Title ends in a bare "${lastWord}"; finish the phrase (e.g. "Coffee Mug").` });
  }

  return { valid: !issues.some((i) => i.severity === "error"), issues };
}
