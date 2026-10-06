import { readFile } from "node:fs/promises";
import path from "node:path";
import { CATALOG_DRAFT_DOC } from "@/lib/catalog-draft";

/** Server-only. Do not import this from a client component. */
export async function readCatalogDraftMarkdown() {
  const absolute = path.join(process.cwd(), CATALOG_DRAFT_DOC);
  try {
    const markdown = await readFile(absolute, "utf8");
    return { markdown, available: true as const, path: CATALOG_DRAFT_DOC };
  } catch {
    return {
      markdown: "",
      available: false as const,
      path: CATALOG_DRAFT_DOC,
    };
  }
}
