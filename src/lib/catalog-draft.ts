import { readFile } from "node:fs/promises";
import path from "node:path";

/** Counts taken from the 2026-10-05 Meridian + Listing package. Flag only; nothing writes to Etsy. */
export const CATALOG_DRAFT_SUMMARY = {
  title: "Catalog order (draft)",
  source: "Meridian + Listing package 2026-10-05",
  retitles: 7,
  imageGaps: 2,
  setCoverGaps: 3,
  exitCandidates: 1,
  sections: 5,
  docPath: "docs/omnishop-catalog-diff-2026-10-05.md",
} as const;

export const CATALOG_DRAFT_DOC = CATALOG_DRAFT_SUMMARY.docPath;

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
