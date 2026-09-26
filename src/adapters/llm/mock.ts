import type { Niche } from "@/db/schema";
import type { ListingBrief, ListingCopy, LLMProvider } from "./types";

const title = (s: string) => s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());

const PRODUCT_NOUN: Record<string, string> = {
  digital: "Printable Digital Download",
  posterA3: "Art Print Poster",
  mug: "Ceramic Mug",
  tshirt: "Unisex T-Shirt",
  sweatshirt: "Cozy Sweatshirt",
};

const NICHE_COPY: Record<Niche, { hooks: string[]; tags: string[]; body: string }> = {
  alpine: {
    hooks: ["Minimalist Swiss Mountain Art", "Alpine Landscape Wall Decor", "Scandi Nature Gallery Art"],
    tags: [
      "swiss alps art", "mountain wall art", "alpine decor", "minimalist poster", "nature print",
      "scandi wall art", "switzerland gift", "hiking gift", "cabin decor", "matterhorn",
      "travel poster", "gallery wall", "neutral wall art", "mountain lover", "living room art",
    ],
    body: "Bring the calm of the Swiss Alps into your home. Clean shapes, soft grain and a muted earthy palette make this piece easy to style in living rooms, offices and cabins.",
  },
  gothic: {
    hooks: ["Dark Floral Gothic Design", "Moody Autumn Botanical", "Witchy Vintage Florals"],
    tags: [
      "gothic floral", "dark academia", "halloween shirt", "witchy gift", "moody botanical",
      "autumn florals", "spooky season", "vintage flowers", "goth gift", "fall aesthetic",
      "plum and burgundy", "dark cottagecore", "halloween decor", "skull flowers", "gothic art",
    ],
    body: "Plum and burgundy blooms with a gothic twist, drawn for the spooky season and beyond. A moody vintage botanical look that pairs with candlelight and dark academia style.",
  },
  christmas: {
    hooks: ["Cozy Alpine Christmas Design", "Hygge Winter Holiday Gift", "Warm Candlelight Christmas Art"],
    tags: [
      "cozy christmas", "christmas gift", "hygge decor", "winter art", "holiday mug",
      "alpine christmas", "gift for her", "stocking stuffer", "xmas present", "snowy cabin",
      "christmas decor", "cozy season", "secret santa gift", "festive art", "winter village",
    ],
    body: "A warm, hand-drawn holiday scene in pine green and candle red. Made for slow winter mornings, cozy evenings and thoughtful gifts under the tree.",
  },
  birthday: {
    hooks: ["Editable Birthday Invitation Template", "Instant Download Party Invite", "Whimsical Kids Birthday Invite"],
    tags: [
      "birthday invitation", "editable invite", "kids party invite", "printable invite", "instant download",
      "first birthday", "silly goose party", "girl birthday", "boy birthday", "party template",
      "corjl template", "evite digital", "pastel invitation", "phone invitation", "diy invitation",
    ],
    body: "Edit the text in your browser, then print at home or send it by text. Includes a 5x7 printable version and a phone-sized evite. Fonts and colors are fully editable.",
  },
  stream: {
    hooks: ["Neon Stream Overlay Package", "Cute Emote And Overlay Pack", "Pastel Streamer Asset Bundle"],
    tags: [
      "stream overlay", "streamer package", "emote pack", "vtuber assets", "stream panels",
      "neon overlay", "obs overlay", "gaming overlay", "webcam frame", "stream alerts",
      "cute emotes", "streamer gift", "starting soon", "animated overlay", "kick overlay",
    ],
    body: "A ready-to-use streaming package: webcam frame, starting soon, BRB and ending screens, panels and alert graphics. Transparent PNGs that drop straight into OBS or Streamlabs.",
  },
};

/** Shortens to Etsy's 20-char tag limit on a word boundary ("pastel stream package" → "pastel stream"). */
function fitTag(phrase: string) {
  if (phrase.length <= 20) return phrase;
  const words = phrase.split(" ");
  let out = "";
  for (const w of words) {
    if ((out ? out.length + 1 : 0) + w.length > 20) break;
    out = out ? `${out} ${w}` : w;
  }
  return out || phrase.slice(0, 20);
}

export class MockLLMProvider implements LLMProvider {
  readonly name = "mock-template";

  async writeListing(brief: ListingBrief): Promise<ListingCopy> {
    const copy = NICHE_COPY[brief.niche];
    let noun = PRODUCT_NOUN[brief.productType === "digital" ? "digital" : brief.podPreset ?? "posterA3"];
    if (/\b(print|poster)\b/i.test(brief.keyword) && noun === PRODUCT_NOUN.posterA3) noun = "Wall Art Decor";
    else if (/\bart\b/i.test(brief.keyword) && noun === PRODUCT_NOUN.posterA3) noun = "Poster Print";
    if (/\bprintable\b/i.test(brief.keyword) && noun === PRODUCT_NOUN.digital) noun = "Instant Digital Download";
    const hook = copy.hooks[brief.seed % copy.hooks.length];
    const kw = title(brief.keyword);
    const t = `${kw} ${noun}, ${hook}, Unique Gift Idea`;

    const kwTag = fitTag(brief.keyword.toLowerCase());
    const pool = [kwTag, ...copy.tags];
    const start = brief.seed % copy.tags.length;
    const rotated = [kwTag, ...copy.tags.slice(start), ...copy.tags.slice(0, start)];
    const tags: string[] = [];
    for (const tag of rotated.length ? rotated : pool) {
      if (tag.length <= 20 && !tags.includes(tag)) tags.push(tag);
      if (tags.length === 13) break;
    }

    const what =
      brief.productType === "digital"
        ? "WHAT YOU GET\n• High-resolution files (300 DPI)\n• Sizes: 2:3, 3:4, 4:5, ISO A-series, 11x14\n• Instant download after purchase"
        : "DETAILS\n• Premium print, made to order\n• Printed and shipped by our production partner\n• Colors may vary slightly between screens";
    return {
      title: t,
      tags,
      body: `${copy.body}\n\n${what}`,
      costChf: 0,
      provider: this.name,
    };
  }
}
