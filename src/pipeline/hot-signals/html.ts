export type HtmlNode = {
  tag: string;
  attrs: Record<string, string>;
  children: (HtmlNode | string)[];
};

export function decodeHtml(value: string): string {
  const named: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (entity, code: string) => {
    if (code.startsWith("#")) {
      const point = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : entity;
    }
    return named[code.toLowerCase()] ?? entity;
  });
}

/** Small structural reader: only explicit, closed card elements are trusted by providers. */
export function parseHtml(html: string): HtmlNode {
  const root: HtmlNode = { tag: "root", attrs: {}, children: [] };
  const stack = [root];
  const voids = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  const clean = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  for (const token of clean.matchAll(/<\/?[a-z][^>]*>|[^<]+/gi)) {
    const raw = token[0];
    if (!raw.startsWith("<")) {
      stack[stack.length - 1].children.push(decodeHtml(raw));
      continue;
    }
    const opening = raw.match(/^<\/?([a-z][\w:-]*)/i);
    const tag = opening?.[1].toLowerCase();
    if (!tag) continue;
    if (raw.startsWith("</")) {
      const index = stack.findLastIndex((node) => node.tag === tag);
      if (index > 0) stack.length = index;
      continue;
    }
    const attrs: Record<string, string> = {};
    const attrText = raw.slice(opening![0].length, -1);
    for (const match of attrText.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
      attrs[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? "");
    }
    const node: HtmlNode = { tag, attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!voids.has(tag) && !raw.endsWith("/>")) stack.push(node);
  }
  return root;
}

export function htmlText(node: HtmlNode): string {
  return node.children.map((child) => typeof child === "string" ? child : htmlText(child)).join(" ").replace(/\s+/g, " ").trim();
}

export function htmlNodes(node: HtmlNode, matches: (node: HtmlNode) => boolean): HtmlNode[] {
  return node.children.flatMap((child) => typeof child === "string" ? [] : [
    ...(matches(child) ? [child] : []), ...htmlNodes(child, matches),
  ]);
}

export function hasClass(node: HtmlNode, name: string): boolean {
  return (node.attrs.class ?? "").split(/\s+/).includes(name);
}

export function positiveRank(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function productUrl(raw: unknown, provider: "amazon" | "etsy"): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const host = provider === "amazon" ? "www.amazon.com" : "www.etsy.com";
    const url = new URL(raw, `https://${host}`);
    if (url.protocol !== "https:" || url.username || url.password || url.port || ![host, host.slice(4)].includes(url.hostname)) return null;
    const id = provider === "amazon" ? url.pathname.match(/\/dp\/([a-z0-9]{10})(?:\/|$)/i)?.[1] : url.pathname.match(/^\/(?:[a-z]{2}\/)?listing\/(\d+)(?:\/|$)/)?.[1];
    return id ? `https://${host}/${provider === "amazon" ? "dp" : "listing"}/${id}` : null;
  } catch {
    return null;
  }
}
