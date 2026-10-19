import fs from "fs";
import path from "path";
import matter from "gray-matter";

export type NoteKind = "reel" | "idea" | "summary" | "home" | "template";
export interface Note {
  id: string; // path relative to vault without .md, e.g. "Reels/2026-03-31 mavgpt DWjdnxMCpcL"
  name: string; // basename
  kind: NoteKind;
  title: string;
  data: Record<string, unknown>;
  body: string;
  links: string[]; // resolved note ids
  tags: string[];
}
export interface Vault { notes: Note[]; byId: Map<string, Note>; loadedAt: number }

const WIKILINK = /\[\[([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]+))?\]\]/g;

export function vaultDir(): string {
  const d = process.env.BRAIN_VAULT_DIR || "data/omnibrain/vault";
  return path.isAbsolute(d) ? d : path.join(/*turbopackIgnore: true*/ process.cwd(), d);
}

function walk(dir: string, base = ""): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
    else if (e.name.endsWith(".md")) out.push(rel);
  }
  return out;
}

export function kindOf(id: string): NoteKind {
  const top = id.split("/")[0];
  if (top === "Reels") return "reel";
  if (top === "Ideas") return "idea";
  if (top === "Summaries") return "summary";
  if (top === "_Templates") return "template";
  return "home";
}

function normDate(v: unknown): unknown {
  return v instanceof Date ? v.toISOString().slice(0, 10) : v;
}

export function buildResolver(ids: string[]) {
  const exact = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const id of ids) {
    exact.set(id.toLowerCase(), id);
    const n = id.split("/").pop()!.toLowerCase();
    if (!byName.has(n)) byName.set(n, id);
  }
  return (target: string): string | undefined => {
    const t = target.trim().replace(/\.md$/, "").toLowerCase();
    return exact.get(t) ?? byName.get(t) ?? byName.get(t.split("/").pop()!);
  };
}

export function extractLinks(text: string, resolve: (t: string) => string | undefined): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(WIKILINK)) {
    const id = resolve(m[1]);
    if (id) out.add(id);
  }
  return [...out];
}

export function parseVault(dir: string): Vault {
  const files = walk(dir);
  const ids = files.map((f) => f.replace(/\.md$/, ""));
  const resolve = buildResolver(ids);
  const notes: Note[] = files.map((f, i) => {
    const raw = fs.readFileSync(path.join(dir, f), "utf8");
    let parsed: { data: Record<string, unknown>; content: string };
    try { parsed = matter(raw) as unknown as typeof parsed; } catch { parsed = { data: {}, content: raw }; }
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed.data || {})) data[k] = normDate(v);
    const id = ids[i];
    const h1 = parsed.content.match(/^#\s+(.+)$/m)?.[1]?.trim();
    const tags = Array.isArray(data.tags) ? (data.tags as unknown[]).map(String) : [];
    const linkText = parsed.content + "\n" + JSON.stringify(data.source_reels ?? "");
    return {
      id, name: id.split("/").pop()!, kind: kindOf(id), title: h1 || id.split("/").pop()!,
      data, body: parsed.content, links: extractLinks(linkText, resolve).filter((l) => l !== id), tags,
    };
  });
  return { notes, byId: new Map(notes.map((n) => [n.id, n])), loadedAt: Date.now() };
}

let cache: Vault | null = null;
export function getVault(): Vault {
  // Vault ships with the deploy, so it only changes on redeploy; cache for the process lifetime.
  if (!cache) cache = parseVault(vaultDir());
  return cache;
}

export function noteHref(id: string): string {
  return "/brain/note/" + id.split("/").map(encodeURIComponent).join("/");
}

export function wikilinksToMarkdown(md: string, resolve: (t: string) => string | undefined): string {
  return md.replace(WIKILINK, (_m, target: string, _h, alias?: string) => {
    const id = resolve(target);
    const label = (alias || target.split("/").pop() || target).replace(/[[\]]/g, "");
    return id ? `[${label}](${noteHref(id)})` : `*${label}*`;
  });
}

export function sectionOf(body: string, heading: string): string {
  const re = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\s*$([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))`, "m");
  return (body.match(re)?.[1] || "").trim();
}

const GENERIC_TAGS = new Set(["reel", "idea"]);
export function graphData(v: Vault, minTagUse = 2) {
  const nodes: { id: string; name: string; kind: string; tags: string[]; status: string }[] = v.notes.filter((n) => n.kind !== "template").map((n) => ({
    id: n.id, name: n.title, kind: n.kind, tags: n.tags, status: String(n.data.status ?? ""),
  }));
  const keep = new Set(nodes.map((n) => n.id));
  const links: { source: string; target: string; kind: string }[] = [];
  for (const n of v.notes) for (const l of n.links) if (keep.has(n.id) && keep.has(l)) links.push({ source: n.id, target: l, kind: "link" });
  // Tag hubs cluster reels by theme so unlinked reels don't float alone.
  const use = new Map<string, number>();
  for (const n of v.notes) if (keep.has(n.id)) for (const t of n.tags) if (!GENERIC_TAGS.has(t)) use.set(t, (use.get(t) || 0) + 1);
  for (const [t, c] of use) if (c >= minTagUse) nodes.push({ id: "tag:" + t, name: "#" + t, kind: "tag", tags: [t], status: "" });
  for (const n of v.notes) if (keep.has(n.id)) for (const t of n.tags) if ((use.get(t) || 0) >= minTagUse) links.push({ source: n.id, target: "tag:" + t, kind: "tag" });
  return { nodes, links };
}

export interface IndexDoc { thumb: string | null; duration: number; id: string; kind: NoteKind; title: string; author: string; handle: string; date: string; lang: string; collection: string; status: string; tags: string[]; summary: string; text: string }
const strip = (s: string) => s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, a, b) => b || a).replace(/[#*_`>|-]+/g, " ").replace(/\s+/g, " ").trim();
export function searchIndex(v: Vault, kinds: NoteKind[] = ["reel", "idea", "summary", "home"]): IndexDoc[] {
  return v.notes.filter((n) => kinds.includes(n.kind)).map((n) => ({
    thumb: thumbFor(n), duration: Number(n.data.duration) || 0,
    id: n.id, kind: n.kind, title: n.title, author: String(n.data.author ?? ""), handle: String(n.data.author_handle ?? ""),
    date: String(n.data.date_posted ?? n.data.created ?? ""), lang: String(n.data.language ?? ""), collection: String(n.data.saved_collection ?? ""),
    status: String(n.data.status ?? ""), tags: n.tags,
    summary: strip(sectionOf(n.body, "Summary") || sectionOf(n.body, "Concept") || n.body.slice(0, 400)).slice(0, 280),
    text: strip(n.body),
  }));
}

let thumbSet: Set<string> | null = null;
export function thumbFor(n: Note): string | null {
  if (!thumbSet) {
    const d = thumbsDir();
    thumbSet = new Set(fs.existsSync(d) ? fs.readdirSync(d).map((f) => f.replace(/\.webp$/, "")) : []);
  }
  const c = String(n.data.shortcode || "");
  return c && thumbSet.has(c) ? `/api/brain/thumb/${encodeURIComponent(c)}` : null;
}

export function thumbsDir(): string {
  const d = process.env.BRAIN_THUMBS_DIR || "data/omnibrain/thumbs";
  return path.isAbsolute(d) ? d : path.join(/*turbopackIgnore: true*/ process.cwd(), d);
}
