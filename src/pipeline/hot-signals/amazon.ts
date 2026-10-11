import { createHash, createHmac } from "node:crypto";
import { config } from "@/lib/config";
import { activeNiches } from "@/lib/niches";
import { AMAZON_POD_PAGES, hotFetcher, type HotFetcher } from "./fetch";
import { hasClass, htmlNodes, htmlText, object, parseHtml, positiveRank, productUrl } from "./html";
import { hotKeywordSource, type HotSignal } from "./types";

const AMAZON_API = "https://webservices.amazon.com/paapi5/searchitems";
const MARKETPLACES = new Set(["US", "amazon.com", "www.amazon.com"]);

export function parseAmazonApi(body: unknown, now: Date): HotSignal[] {
  const items = object(object(body).SearchResult).Items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((raw): HotSignal[] => {
    const item = object(raw);
    const title = object(object(item.ItemInfo).Title).DisplayValue;
    const url = productUrl(item.DetailPageURL, "amazon");
    if (typeof title !== "string" || !title.trim() || !url) return [];
    const info = object(item.BrowseNodeInfo);
    const nodes = Array.isArray(info.BrowseNodes) ? info.BrowseNodes.map(object) : [];
    const rankedNode = nodes.find((node) => positiveRank(node.SalesRank) !== null);
    const website = object(info.WebsiteSalesRank);
    const observed = rankedNode ?? website;
    const category = observed.DisplayName ?? observed.ContextFreeName;
    return [{
      provider: "amazon", category: typeof category === "string" ? category : null,
      title: title.trim(), phrase: title.trim().toLowerCase(),
      rank: positiveRank(observed.SalesRank), badge: null, label_text: null, metric: null,
      source_url: url, fetched_at: now,
    }];
  });
}

export function parseAmazonHtml(html: string, opts: { now: Date; category: string }): HotSignal[] {
  const root = parseHtml(html);
  const isCard = (node: Parameters<typeof hasClass>[0]) => node.attrs.id === "gridItemRoot" || hasClass(node, "zg-item-immersion");
  const cards = htmlNodes(root, isCard).filter((node) => node.closed && !htmlNodes(node, isCard).length);
  return cards.flatMap((card): HotSignal[] => {
    const links = htmlNodes(card, (node) => node.tag === "a" && productUrl(node.attrs.href, "amazon") !== null);
    if (new Set(links.map((link) => productUrl(link.attrs.href, "amazon"))).size !== 1) return [];
    const link = links[0];
    const url = productUrl(link?.attrs.href, "amazon");
    const titles = htmlNodes(card, (node) => hasClass(node, "p13n-sc-truncate") || hasClass(node, "p13n-sc-truncated") || (node.attrs.class ?? "").split(/\s+/).some((name) => /^_cDEzb_p13n-sc-css-line-clamp-/.test(name)));
    const title = titles.map(htmlText).find(Boolean) ?? link?.attrs.title ?? "";
    if (!url || !title.trim()) return [];
    const label = htmlNodes(card, (node) => hasClass(node, "zg-bdg-text")).map(htmlText).find((text) => /^#[1-9]\d{0,2}(?:,\d{3})*$|^#[1-9]\d*$/.test(text));
    const rank = label ? positiveRank(Number(label.slice(1).replace(/,/g, ""))) : null;
    return [{
      provider: "amazon", category: opts.category, title: title.trim(), phrase: title.trim().toLowerCase(),
      rank, badge: null, label_text: label ?? null, metric: null,
      source_url: url, fetched_at: opts.now,
    }];
  });
}

export function signAmazonSearch(
  body: string,
  credentials: { accessKey: string; secretKey: string },
  now: Date,
): Record<string, string> {
  const date = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = date.slice(0, 8);
  const headers: Record<string, string> = {
    "content-encoding": "amz-1.0",
    "content-type": "application/json; charset=utf-8",
    host: "webservices.amazon.com",
    "x-amz-date": date,
    "x-amz-target": "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.SearchItems",
  };
  const names = Object.keys(headers).sort();
  const signed = names.join(";");
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const canonical = ["POST", "/paapi5/searchitems", "", names.map((name) => `${name}:${headers[name]}\n`).join(""), signed, hash(body)].join("\n");
  const scope = `${day}/us-east-1/ProductAdvertisingAPI/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", date, scope, hash(canonical)].join("\n");
  const hmac = (key: string | Buffer, value: string) => createHmac("sha256", key).update(value).digest();
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${credentials.secretKey}`, day), "us-east-1"), "ProductAdvertisingAPI"), "aws4_request");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKey}/${scope}, SignedHeaders=${signed}, Signature=${createHmac("sha256", signingKey).update(toSign).digest("hex")}`;
  return headers;
}

type AmazonSettings = {
  scrapeEnabled: boolean;
  amazonAccessKey?: string;
  amazonSecretKey?: string;
  amazonPartnerTag?: string;
  amazonMarketplace: string;
};

export function createAmazonSource(deps: { settings?: () => AmazonSettings; fetcher?: HotFetcher } = {}) {
  return hotKeywordSource("amazon", async (opts) => {
    if (opts.demo) return [];
    const settings = (deps.settings ?? (() => config.hot))();
    if (!MARKETPLACES.has(settings.amazonMarketplace)) {
      opts.log("Amazon hot signals: unsupported marketplace; skipped", "warn");
      return [];
    }
    const fetcher = deps.fetcher ?? hotFetcher;
    const out: HotSignal[] = [];
    if (settings.amazonAccessKey && settings.amazonSecretKey && settings.amazonPartnerTag) {
      const searches = activeNiches().filter((niche) => niche.productMix.some((product) => product.type === "pod")).map((niche) => ({
        Keywords: niche.seeds[0].phrase,
        SearchIndex: niche.id === "gothic" ? "Apparel" : "HomeAndKitchen",
      }));
      for (const search of searches) {
        const body = JSON.stringify({
          ...search, ItemCount: 10, PartnerTag: settings.amazonPartnerTag, PartnerType: "Associates",
          Marketplace: "www.amazon.com",
          Resources: ["ItemInfo.Title", "BrowseNodeInfo.BrowseNodes", "BrowseNodeInfo.BrowseNodes.SalesRank", "BrowseNodeInfo.WebsiteSalesRank"],
        });
        const headers = signAmazonSearch(body, { accessKey: settings.amazonAccessKey, secretKey: settings.amazonSecretKey }, new Date());
        const response = await fetcher.json(AMAZON_API, { log: opts.log, init: { method: "POST", body, headers } });
        if (Array.isArray(object(response).Errors) && (object(response).Errors as unknown[]).length) {
          opts.log("Amazon hot signals: API rejected SearchItems", "warn");
          throw new Error("Amazon hot signals: API rejected SearchItems");
        }
        out.push(...parseAmazonApi(response, opts.now));
      }
    }
    if (settings.scrapeEnabled && !(settings.amazonAccessKey && settings.amazonSecretKey && settings.amazonPartnerTag)) {
      for (const page of AMAZON_POD_PAGES) {
        const html = await fetcher.html(`https://www.amazon.com${page.path}`, { scrapeEnabled: true, log: opts.log });
        if (html != null) out.push(...parseAmazonHtml(html, { now: opts.now, category: page.category }));
      }
    }
    return out;
  });
}

export const amazonSource = createAmazonSource();
