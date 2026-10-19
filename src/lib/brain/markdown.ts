import { Marked } from "marked";
import { buildResolver, getVault, wikilinksToMarkdown } from "./vault";

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const marked = new Marked({ gfm: true, breaks: true });
marked.use({ renderer: { html({ text }) { return escape(text); } } });

export function renderMarkdown(md: string): string {
  const v = getVault();
  const resolve = buildResolver(v.notes.map((n) => n.id));
  return marked.parse(wikilinksToMarkdown(md, resolve)) as string;
}
