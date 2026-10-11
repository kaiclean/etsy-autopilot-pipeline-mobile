import type { HotCollectOptions } from "./types";

export const HOT_USER_AGENT = "EtsyAutopilotHotSignals/1.0";
export const AMAZON_POD_PAGES = [
  { category: "Posters & Prints", path: "/gp/bestsellers/home-garden/381142011" },
  { category: "Coffee Mugs", path: "/gp/bestsellers/kitchen/367142011" },
  { category: "Posters & Prints", path: "/gp/movers-and-shakers/home-garden/381142011" },
  { category: "Coffee Mugs", path: "/gp/movers-and-shakers/kitchen/367142011" },
] as const;

type Log = HotCollectOptions["log"];
type FetchDeps = {
  fetchImpl?: typeof fetch;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
};

function approvedUrl(raw: string | URL, kind: "api" | "html" | "robots"): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Hot signals: unapproved source URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) {
    throw new Error("Hot signals: unapproved source URL");
  }
  const apiPaths: Record<string, string> = {
    "webservices.amazon.com": "/paapi5/searchitems",
    "openapi.etsy.com": "/v3/application/listings/active",
    "api.pinterest.com": "/v5/trends/keywords/US/top/growing",
  };
  const valid = kind === "api"
    ? apiPaths[url.hostname] === url.pathname
    : kind === "robots"
      ? ["www.amazon.com", "www.etsy.com"].includes(url.hostname) && url.pathname === "/robots.txt" && !url.search
      : (url.hostname === "www.amazon.com" && AMAZON_POD_PAGES.some((page) => page.path === url.pathname.replace(/\/$/, "")) && !url.search)
        || (url.hostname === "www.etsy.com" && url.pathname === "/search" && [...url.searchParams.keys()].every((key) => ["q", "order"].includes(key)));
  if (!valid) throw new Error("Hot signals: unapproved source URL");
  return url;
}

/** RFC-style longest matching rule, scoped to this crawler rather than page text. */
export function robotsAllows(text: string, url: URL): boolean {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
  let group = { agents: [] as string[], rules: [] as { allow: boolean; path: string }[] };
  let hasRules = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const split = line.indexOf(":");
    if (split < 0) continue;
    const key = line.slice(0, split).trim().toLowerCase();
    const value = line.slice(split + 1).trim();
    if (key === "user-agent") {
      if (hasRules) {
        groups.push(group);
        group = { agents: [], rules: [] };
        hasRules = false;
      }
      group.agents.push(value.toLowerCase());
    } else if (group.agents.length && ["allow", "disallow"].includes(key)) {
      hasRules = true;
      if (value) group.rules.push({ allow: key === "allow", path: value });
    }
  }
  groups.push(group);
  const agent = HOT_USER_AGENT.toLowerCase();
  const specificity = (agents: string[]) => Math.max(-1, ...agents.map((a) => a === "*" ? 0 : a && agent.includes(a) ? a.length : -1));
  const best = Math.max(-1, ...groups.map((g) => specificity(g.agents)));
  if (best < 0) return true;
  const target = url.pathname + url.search;
  let winner: { length: number; allow: boolean } | undefined;
  for (const g of groups.filter((g) => specificity(g.agents) === best)) {
    for (const rule of g.rules) {
      const end = rule.path.endsWith("$");
      const path = end ? rule.path.slice(0, -1) : rule.path;
      const pattern = path.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
      if (!new RegExp(`^${pattern}${end ? "$" : ""}`).test(target)) continue;
      const length = path.replace(/\*/g, "").length;
      if (!winner || length > winner.length || (length === winner.length && rule.allow)) winner = { length, allow: rule.allow };
    }
  }
  return winner?.allow ?? true;
}

export function createHotFetcher(deps: FetchDeps = {}) {
  const clock = deps.clock ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const queues = new Map<string, Promise<void>>();
  const lastRequest = new Map<string, number>();
  const robots = new Map<string, { text: string; expires: number }>();

  async function waitForHost(host: string) {
    const previous = queues.get(host) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const last = lastRequest.get(host);
      if (last != null) await sleep(Math.max(0, last + 2000 - clock()));
      lastRequest.set(host, clock());
    });
    queues.set(host, next);
    await next;
  }

  async function request(url: URL, init: RequestInit, log: Log): Promise<string> {
    await waitForHost(url.hostname);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 8000);
    try {
      const headers = new Headers(init.headers);
      headers.set("User-Agent", HOT_USER_AGENT);
      const response = await (deps.fetchImpl ?? fetch)(url, {
        ...init, headers, signal: controller.signal, redirect: "manual", cache: "no-store",
      });
      if (!response.ok || response.redirected) {
        throw new Error(`Hot signals: ${url.hostname} HTTP ${response.status}`);
      }
      if (Number(response.headers.get("content-length")) > 2_000_000) throw new Error("response too large");
      const reader = response.body?.getReader();
      if (!reader) return "";
      const decoder = new TextDecoder();
      let text = "";
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 2_000_000) {
            await reader.cancel();
            throw new Error("response too large");
          }
          text += decoder.decode(value, { stream: true });
        }
        return text + decoder.decode();
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      const status = error instanceof Error ? error.message.match(/HTTP (\d{3})$/)?.[1] : undefined;
      const message = `Hot signals: ${url.hostname} ${status ? `HTTP ${status}` : "request failed"}`;
      log(message, "warn");
      throw new Error(message);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    waitForHost,
    async json(url: string | URL, opts: { log: Log; init?: RequestInit }): Promise<unknown> {
      const approved = approvedUrl(url, "api");
      const text = await request(approved, opts.init ?? {}, opts.log);
      try {
        return JSON.parse(text) as unknown;
      } catch {
        const message = `Hot signals: ${approved.hostname} invalid JSON`;
        opts.log(message, "warn");
        throw new Error(message);
      }
    },
    async html(url: string | URL, opts: { scrapeEnabled: boolean; log: Log }): Promise<string | null> {
      if (!opts.scrapeEnabled) return null;
      const approved = approvedUrl(url, "html");
      let policy = robots.get(approved.hostname);
      if (!policy || policy.expires <= clock()) {
        const robotsUrl = approvedUrl(new URL("/robots.txt", approved), "robots");
        policy = { text: await request(robotsUrl, {}, opts.log), expires: clock() + 3600_000 };
        // A successful HTML challenge is not a robots policy; fail closed.
        if (/<(?:html|script|body)\b/i.test(policy.text) || !/^[ \t]*user-agent[ \t]*:[ \t]*(?:\*|[a-z][a-z0-9_-]*)(?:[ \t]*(?:#.*)?)?$/im.test(policy.text)) {
          const message = `Hot signals: ${approved.hostname} robots policy unavailable`;
          opts.log(message, "warn");
          throw new Error(message);
        }
        robots.set(approved.hostname, policy);
      }
      if (!robotsAllows(policy.text, approved)) {
        opts.log(`Hot signals: ${approved.hostname} robots disallows scraping`, "warn");
        return null;
      }
      return request(approved, {}, opts.log);
    },
  };
}

export const hotFetcher = createHotFetcher();
export type HotFetcher = ReturnType<typeof createHotFetcher>;
