import { Marked } from "marked";
import { buildResolver, getVault, wikilinksToMarkdown, type Vault } from "./vault";

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const marked = new Marked({ gfm: true, breaks: true });
marked.use({ renderer: {
  html({ text }) { return escape(text); },
  link({ href, tokens }) {
    const label = this.parser.parseInline(tokens);
    const safe = /^(https?:\/\/|mailto:|\/(?!\/)|#)/i.test(href.trim());
    return safe ? `<a href="${escape(href).replace(/"/g, "&quot;")}">${label}</a>` : label;
  },
  image({ text }) { return escape(text); },
} });

export function renderMarkdown(md: string, vault?: Vault): string {
  const v = vault ?? getVault();
  const resolve = buildResolver(v.notes.map((n) => n.id));
  return marked.parse(wikilinksToMarkdown(md, resolve)) as string;
}
