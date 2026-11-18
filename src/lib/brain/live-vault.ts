import { getDb, type DB } from "@/db";
import { brainVaultNotes } from "@/db/schema";
import { buildResolver, extractLinks, getVault, kindOf, parseFrontMatter, type Note, type Vault } from "./vault";

export function mergeVault(base: Vault, imports: { id: string; markdown: string }[]): Vault {
  const notes = new Map(base.notes.map(n => [n.id, n]));
  for (const row of imports) {
    const { data, content } = parseFrontMatter(row.markdown);
    notes.set(row.id, { id: row.id, name: row.id.split("/").pop()!, kind: kindOf(row.id),
      title: content.match(/^#\s+(.+)$/m)?.[1]?.trim() || row.id.split("/").pop()!,
      data, body: content, tags: Array.isArray(data.tags) ? data.tags.map(String) : [], links: [] });
  }
  const resolve = buildResolver([...notes.keys()]);
  const linked: Note[] = [...notes.values()].map(n => ({ ...n,
    links: extractLinks(n.body + "\n" + JSON.stringify(n.data.source_reels ?? ""), resolve).filter(id => id !== n.id),
  }));
  return { notes: linked, byId: new Map(linked.map(n => [n.id, n])), loadedAt: Date.now() };
}

/** No process cache: fresh worker imports must appear on every deployed instance. */
export async function getLiveVault(db?: DB): Promise<Vault> {
  const rows = await (db ?? await getDb()).select({ id: brainVaultNotes.id, markdown: brainVaultNotes.markdown }).from(brainVaultNotes);
  return mergeVault(getVault(), rows);
}
