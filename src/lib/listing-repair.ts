import { requiredDisclosures } from "./disclosures";
import { ETSY_LIMITS, FAMILIES, PRAISE_SOURCE, TAG_STOP, type ListingDraft } from "./listing-rules";

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

const NEUTRAL_TAGS = [
  "home decor",
  "wall decor",
  "art print",
  "room accent",
  "gallery piece",
  "neutral art",
  "modern decor",
  "cozy style",
  "art lover",
  "gift print",
  "interior art",
  "calm artwork",
  "styled print",
];

const PRODUCT_FAMILY = /\b(?:tote(?: bags?)?|phone cases?|canvases|canvas|stickers?|blankets?|hoodies?|ornaments?|mugs?|posters?|sweatshirts?|(?:t[ -]?)?shirts?|tees?)\b/i;

function rememberTag(tags: string[], seen: Set<string>, raw: string) {
  if (tags.length >= ETSY_LIMITS.tagCount) return;
  const tag = raw.replace(/[^\p{L}\p{N} '\-]/gu, " ").replace(/\s+/g, " ").trim().toLowerCase();
  if (!tag || tag.length > ETSY_LIMITS.tagMax || seen.has(tag) || PRODUCT_FAMILY.test(tag)) return;
  seen.add(tag);
  tags.push(tag);
}

function allowedFamilies(product: { type: ListingDraft["productType"]; pod?: string }) {
  if (product.type === "digital") return new Set<string>(["poster"]);
  const hit = FAMILIES.find((row) => product.pod && (row.presets as readonly string[]).includes(product.pod));
  return new Set(hit ? [hit.family] : []);
}

function softenShoutedTitle(title: string) {
  let changed = false;
  const next = title.replace(/\S+/g, (word) => {
    const letters = word.replace(/[^\p{L}]/gu, "");
    if (letters.length > 1 && letters === letters.toUpperCase()) {
      changed = true;
      return word.replace(/\p{L}+/gu, (chunk) => chunk.charAt(0) + chunk.slice(1).toLowerCase());
    }
    return word;
  });
  return { title: next, changed };
}

function stripPraise(text: string) {
  const re = new RegExp(PRAISE_SOURCE, "gi");
  if (!re.test(text)) return { text, changed: false };
  const next = text
    .replace(new RegExp(PRAISE_SOURCE, "gi"), " ")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\s+([,.;!?])/g, "$1")
    .trim();
  return { text: next, changed: true };
}

/**
 * Truncates the title to 140, each tag to 20, and fills or trims the list to exactly 13.
 * Shouted words become Title Case and empty praise is removed before the gate.
 * Product words (mug, poster, shirt) are not invented. Other gate failures stay for review.
 */
export function repairTrivialCopy<T extends ListingDraft>(
  d: T,
  opts?: { keyword?: string; product?: { type: ListingDraft["productType"]; pod?: string } },
): { draft: T; fixes: string[] } {
  const fixes: string[] = [];
  let title = (d.title ?? "").replace(/\s+/g, " ").trim();
  let description = d.description ?? "";
  const shouted = softenShoutedTitle(title);
  if (shouted.changed) {
    title = shouted.title;
    fixes.push("rewrote all-caps words into title case");
  }
  const titlePraise = stripPraise(title);
  if (titlePraise.changed) {
    title = titlePraise.text;
    fixes.push("removed empty praise from the title");
  }
  const bodyPraise = stripPraise(description);
  if (bodyPraise.changed) {
    description = bodyPraise.text;
    fixes.push("removed empty praise from the description");
  }
  // Re-validated older drafts (e.g. after a box upscale) must still carry the required Etsy disclosures.
  const missing = requiredDisclosures(d.productType).filter((disclosure) => !description.includes(disclosure));
  if (missing.length) {
    description = [description.trimEnd(), ...missing].filter(Boolean).join("\n\n");
    fixes.push("added the required AI / production-partner disclosures");
  }
  const keyword = opts?.keyword?.replace(/\s+/g, " ").trim();
  if (keyword && !title.toLowerCase().startsWith(keyword.toLowerCase())) {
    const lead = keyword.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
    title = `${lead} ${title}`.replace(/\s+/g, " ").trim();
    fixes.push("moved the buyer keyword to the front of the title");
  }
  if (opts?.product) {
    const allowed = allowedFamilies(opts.product);
    let stripped = title;
    for (const family of FAMILIES) {
      if (allowed.has(family.family)) continue;
      stripped = stripped.replace(new RegExp(family.pattern.source, "gi"), " ");
    }
    if (opts.product.type === "pod" && opts.product.pod !== "posterA3" && opts.product.pod !== "canvas") {
      stripped = stripped.replace(/\b(?:wall[ -]+art|prints?|printables?|digital|downloads?)\b/gi, " ");
    }
    stripped = stripped.replace(/\s+/g, " ").replace(/\s+\|/g, " |").trim();
    if (stripped !== title) {
      title = stripped;
      fixes.push("removed product words that do not match this variant");
    }
  }
  const trimmedTitle = title;
  const rawTags = d.tags ?? [];
  const sanitized = sanitizeDraft({ ...d, title, description });
  if (trimmedTitle.length > ETSY_LIMITS.titleMax) fixes.push("shortened the title to 140 characters");
  if (rawTags.some((tag) => tag.trim().length > ETSY_LIMITS.tagMax)) fixes.push("shortened tags to 20 characters");

  const tags = [...sanitized.tags];
  if (rawTags.length !== ETSY_LIMITS.tagCount || tags.length !== ETSY_LIMITS.tagCount) {
    fixes.push("set the tag list to 13");
    const seen = new Set(tags);
    for (const filler of NEUTRAL_TAGS) rememberTag(tags, seen, filler);
    const words = sanitized.title
      .toLowerCase()
      .split(/[^\p{L}\p{N}']+/u)
      .filter((word) => word.length >= 3 && word.length <= ETSY_LIMITS.tagMax);
    for (const word of words) rememberTag(tags, seen, word);
    for (let i = 0; i < words.length - 1; i++) rememberTag(tags, seen, `${words[i]} ${words[i + 1]}`);
    let n = 1;
    while (tags.length < ETSY_LIMITS.tagCount && n < 40) {
      rememberTag(tags, seen, `art detail ${n}`);
      n++;
    }
  }
  if (opts?.product) {
    const allowed = allowedFamilies(opts.product);
    const before = tags.length;
    const kept = tags.filter((tag) => FAMILIES.every((family) => allowed.has(family.family) || !family.pattern.test(tag)));
    if (kept.length !== before) {
      tags.length = 0;
      tags.push(...kept);
      fixes.push("dropped tags for a different product");
      const seen = new Set(tags);
      for (const filler of NEUTRAL_TAGS) rememberTag(tags, seen, filler);
      let n = 1;
      while (tags.length < ETSY_LIMITS.tagCount && n < 40) {
        rememberTag(tags, seen, `art detail ${n}`);
        n++;
      }
    }
  }
  const capped = capRepeatedTagWords(tags.slice(0, ETSY_LIMITS.tagCount));
  if (capped.changed) fixes.push("replaced tags that repeated the same word");
  return { draft: { ...sanitized, tags: capped.tags }, fixes };
}

/** Distinct-word fillers so refills never pile onto one word ("art", "dark"). */
const DIVERSE_TAGS = [
  "home decor", "room accent", "gallery piece", "cozy style", "living room",
  "wall hanging", "statement piece", "calm mood", "nature lover", "bedroom styling",
  "office corner", "hallway", "reading nook", "minimalist", "colour palette", "keepsake", "seasonal",
  "illustration", "atmosphere", "texture", "heirloom look", "studio",
];

function tagWords(tag: string) {
  return [...new Set(tag.toLowerCase().split(/[^a-z0-9']+/).filter((word) => word.length >= 3 && !TAG_STOP.has(word)))];
}

/** Keeps every word in at most `max` tags (validator warns at 4, blocks at 5), refilling to 13. */
export function capRepeatedTagWords(input: string[], max = 3) {
  const counts = new Map<string, number>();
  const kept: string[] = [];
  let changed = false;
  for (const tag of input) {
    const words = tagWords(tag);
    if (words.some((word) => (counts.get(word) ?? 0) >= max)) {
      changed = true;
      continue;
    }
    for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
    kept.push(tag);
  }
  const seen = new Set(kept);
  for (const filler of DIVERSE_TAGS) {
    if (kept.length >= ETSY_LIMITS.tagCount) break;
    const words = tagWords(filler);
    if (seen.has(filler) || PRODUCT_FAMILY.test(filler) || words.some((word) => (counts.get(word) ?? 0) >= max)) continue;
    for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
    kept.push(filler);
    seen.add(filler);
  }
  return { tags: kept, changed };
}
