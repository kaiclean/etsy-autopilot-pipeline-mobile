import { createHash } from "node:crypto";
import type { ThemeProduct } from "@/db/schema";
import { sectionOf, type Note, type Vault } from "./vault";

export type BrainProductOrigin = {
  version: 1; noteId: string; title: string; sourceHash: string;
  reels: { id: string; title: string; url: string | null; hash: string }[];
  product: ThemeProduct; direction: string;
};
export const ART_PRODUCTS = ["wall-art", "poster", "pod-apparel", "pod-mug"] as const;
export function isArtProduct(value: unknown): value is typeof ART_PRODUCTS[number] {
  return ART_PRODUCTS.includes(value as typeof ART_PRODUCTS[number]);
}
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function reelSources(note: Note, vault: Vault) {
  if (note.kind === "reel") return { reels: [note], missing: [] as string[] };
  const refs = Array.isArray(note.data.source_reels) ? note.data.source_reels.map(String) : [];
  const reels: Note[] = [], missing: string[] = [];
  for (const ref of refs) {
    const target = (ref.match(/\[\[([^\]|#]+)/)?.[1] ?? ref).replace(/\.md$/, "").toLowerCase();
    const found = vault.notes.find(n => n.kind === "reel" && [n.id, n.name].some(v => v.toLowerCase() === target));
    if (found) { if (!reels.some(n => n.id === found.id)) reels.push(found); }
    else missing.push(ref);
  }
  return { reels, missing };
}
export function reviseProductOrigin(origin: BrainProductOrigin, product: ThemeProduct, direction: string): BrainProductOrigin {
  if (!isArtProduct(product)) throw new Error("Unsupported product");
  const text = direction.trim().replace(/\s+/g, " ");
  if (text.length < 30 || text.length > 1600) throw new Error("Describe your original product direction in 30–1600 characters");
  return { ...origin, product, direction: text };
}
export function makeProductOrigin(note: Note, vault: Vault, product: ThemeProduct, direction: string): BrainProductOrigin {
  if (!isArtProduct(product)) throw new Error("This product requires a real hand-built deliverable before it can enter the artwork pipeline");
  const text = direction.trim().replace(/\s+/g, " ");
  if (text.length < 30 || text.length > 1600) throw new Error("Describe your original product direction in 30–1600 characters");
  const sources = reelSources(note, vault);
  if (sources.missing.length) throw new Error("Resolve missing source reel links before approving this product");
  if (note.kind === "reel" && !sources.reels.length) throw new Error("Source reel is missing");
  return { version: 1, noteId: note.id, title: note.title, sourceHash: hash(note.body), product, direction: text,
    reels: sources.reels.map(n => ({ id: n.id, title: n.title,
      url: typeof n.data.url === "string" && /^https:\/\/www\.instagram\.com\/reel\/[A-Za-z0-9_-]+\/?$/.test(n.data.url) ? n.data.url : null,
      hash: hash(n.body) })) };
}
export function originPrompt(origin: BrainProductOrigin) {
  return `Seller's original product direction (${origin.product}): ${origin.direction}\nCreate a new composition for this brief. Sources are inspiration, not artwork to reproduce. Do not copy a reel frame, creator artwork, brand, logo, character or slogan. No claims of handmade or exclusive authorship. No text or lettering. Human originality review is required.`;
}
export function defaultDirection(note: Note) { return sectionOf(note.body, "Concept").slice(0, 1600); }
