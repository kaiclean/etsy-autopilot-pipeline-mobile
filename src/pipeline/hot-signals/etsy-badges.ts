import { config } from "@/lib/config";
import { activeNiches } from "@/lib/niches";
import { assertOfficialEtsyApi, etsyActiveListingsUrl } from "../etsy-api";
import { hotFetcher, type HotFetcher } from "./fetch";
import { hasClass, htmlNodes, htmlText, object, parseHtml, productUrl } from "./html";
import { hotKeywordSource, type HotSignal } from "./types";

export function parseEtsyApi(body: unknown, now: Date): HotSignal[] {
  const results = object(body).results;
  if (!Array.isArray(results)) return [];
  return results.flatMap((raw): HotSignal[] => {
    const listing = object(raw);
    const url = productUrl(listing.url, "etsy");
    if (typeof listing.title !== "string" || !listing.title.trim() || !url) return [];
    return [{
      provider: "etsy", category: null, title: listing.title.trim(), phrase: listing.title.trim().toLowerCase(),
      rank: null, badge: null, label_text: null, metric: null, source_url: url, fetched_at: now,
    }];
  });
}

export function parseEtsyHtml(html: string, now: Date): HotSignal[] {
  const isCard = (node: Parameters<typeof hasClass>[0]) => /^\d+$/.test(node.attrs["data-listing-id"] ?? "");
  const cards = htmlNodes(parseHtml(html), isCard).filter((node) => node.closed && !htmlNodes(node, isCard).length);
  return cards.flatMap((card): HotSignal[] => {
    const id = card.attrs["data-listing-id"];
    if (htmlNodes(card, (node) => node.tag === "a" && productUrl(node.attrs.href, "etsy") !== null && productUrl(node.attrs.href, "etsy") !== `https://www.etsy.com/listing/${id}`).length) return [];
    const links = htmlNodes(card, (node) => node.tag === "a" && productUrl(node.attrs.href, "etsy") === `https://www.etsy.com/listing/${id}`);
    const link = links[0] ?? (card.tag === "a" && productUrl(card.attrs.href, "etsy") === `https://www.etsy.com/listing/${id}` ? card : undefined);
    if (!link) return [];
    const titleNode = htmlNodes(card, (node) => ["h2", "h3"].includes(node.tag) || hasClass(node, "v2-listing-card__title"))[0];
    const title = titleNode ? htmlText(titleNode) : link.attrs.title ?? "";
    if (!title.trim()) return [];
    const titleNodes = new Set(titleNode ? [titleNode, ...htmlNodes(titleNode, () => true)] : []);
    const labels = htmlNodes(card, (node) => {
      if (titleNodes.has(node) || !["span", "div", "p"].includes(node.tag) || htmlNodes(node, (child) => ["a", "h2", "h3"].includes(child.tag)).length) return false;
      const classes = (node.attrs.class ?? "").split(/\s+/);
      return classes.some((name) => /^wt-badge(?:--|$)/.test(name) || /(?:^|__)badge(?:--|$)/.test(name) || /(?:^|__)urgency(?:--|$)/.test(name))
        || node.attrs["data-bestseller"] === "true";
    }).map(htmlText);
    const badge = labels.find((label) => /^(?:bestseller|best seller|etsy'?s pick)$/i.test(label)) ?? null;
    const salesLabel = htmlNodes(card, (node) => !titleNodes.has(node) && ["span", "p", "div"].includes(node.tag) && node.children.every((child) => typeof child === "string")).map(htmlText).find((label) => /^(?:\d[\d,]*\s+(?:people\s+)?(?:bought|purchased|sold)\s+(?:this\s+)?in\s+(?:the\s+)?last\s+24\s+hours|\d[\d,]*\s+sales\s+in\s+(?:the\s+)?last\s+24\s+hours)$/i.test(label));
    return [{
      provider: "etsy", category: null, title: title.trim(), phrase: title.trim().toLowerCase(),
      rank: null, badge, label_text: salesLabel ?? badge, metric: null,
      source_url: `https://www.etsy.com/listing/${id}`, fetched_at: now,
    }];
  });
}

export function createEtsyBadgesSource(deps: {
  apiKey?: () => string | undefined;
  scrapeEnabled?: () => boolean;
  fetcher?: HotFetcher;
} = {}) {
  return hotKeywordSource("etsy", async (opts) => {
    if (opts.demo) return [];
    const apiKey = deps.apiKey ? deps.apiKey() : config.etsy.apiKey && config.etsy.sharedSecret ? `${config.etsy.apiKey}:${config.etsy.sharedSecret}` : config.etsy.apiKey;
    const fetcher = deps.fetcher ?? hotFetcher;
    const out: HotSignal[] = [];
    const phrases = activeNiches().map((niche) => niche.seeds[Math.floor(opts.now.getTime() / 864e5) % niche.seeds.length].phrase);
    for (const phrase of phrases) {
      if (apiKey) {
        const url = etsyActiveListingsUrl(phrase);
        url.searchParams.set("limit", "10");
        url.searchParams.set("sort_on", "score");
        url.searchParams.set("sort_order", "desc");
        assertOfficialEtsyApi(url.toString());
        const result = await fetcher.json(url, { log: opts.log, init: { headers: { "x-api-key": apiKey } } });
        out.push(...parseEtsyApi(result, opts.now));
      }
    }
    if ((deps.scrapeEnabled ?? (() => config.hot.scrapeEnabled))()) {
      opts.log("Etsy HTML scraping is disabled; API data does not prove bestseller badges or sales", "warn");
    }
    return out;
  });
}

export const etsyBadgesSource = createEtsyBadgesSource();
