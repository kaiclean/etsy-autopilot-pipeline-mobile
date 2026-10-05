import Link from "next/link";
import { PageHeader } from "@/components/common";
import { CATALOG_DRAFT_SUMMARY, readCatalogDraftMarkdown } from "@/lib/catalog-draft";

export const metadata = { title: "Catalog diff" };

export default async function CatalogDraftPage() {
  const doc = await readCatalogDraftMarkdown();
  return (
    <div className="space-y-4">
      <PageHeader
        title={CATALOG_DRAFT_SUMMARY.title}
        subtitle={`${CATALOG_DRAFT_SUMMARY.source}. Read only. This page does not write to Etsy.`}
        action={
          <Link href="/products#catalog-draft" className="text-xs font-medium text-primary">
            Back to products
          </Link>
        }
      />
      {doc.available ? (
        <pre className="overflow-x-auto rounded-2xl border border-border bg-muted/30 p-4 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">{doc.markdown}</pre>
      ) : (
        <p className="text-sm text-muted-foreground">
          The committed diff at <code>{doc.path}</code> is not available in this environment. The review flag in settings still tracks whether Kai has seen the draft.
        </p>
      )}
    </div>
  );
}
