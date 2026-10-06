"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { setCatalogDraftReviewed } from "@/app/actions";
import { Panel, SectionTitle } from "@/components/common";
import { Button, buttonVariants } from "@/components/ui/button";
import { CATALOG_DRAFT_SUMMARY } from "@/lib/catalog-draft";

export function CatalogDraftPanel({ reviewed }: { reviewed: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const counts = [
    `${CATALOG_DRAFT_SUMMARY.retitles} retitles`,
    `${CATALOG_DRAFT_SUMMARY.imageGaps} image gaps`,
    `${CATALOG_DRAFT_SUMMARY.setCoverGaps} set-cover gaps`,
    `${CATALOG_DRAFT_SUMMARY.exitCandidates} exit candidate (VTuber)`,
    `sections ×${CATALOG_DRAFT_SUMMARY.sections}`,
  ];

  return (
    <section id="catalog-draft" className="scroll-mt-20 space-y-3">
      <SectionTitle>{CATALOG_DRAFT_SUMMARY.title}</SectionTitle>
      <Panel className="space-y-3 p-4">
        <div>
          <div className="text-sm font-semibold">{reviewed ? "Reviewed by Kai" : "Pending Kai"}</div>
          <p className="mt-0.5 text-xs text-muted-foreground">Source: {CATALOG_DRAFT_SUMMARY.source}</p>
        </div>
        <ul className="flex flex-wrap gap-1.5">
          {counts.map((count) => (
            <li key={count} className="rounded-full bg-muted px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
              {count}
            </li>
          ))}
        </ul>
        <p className="text-xs leading-relaxed text-muted-foreground">
          This panel only records that Kai reviewed the draft. It does not apply titles, images, or exits on Etsy.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/catalog-draft" className={buttonVariants({ variant: "secondary", className: "h-9 rounded-xl px-3 text-xs" })}>
            Open diff
          </Link>
          <Button
            type="button"
            variant={reviewed ? "secondary" : "default"}
            className="h-9 rounded-xl px-3 text-xs"
            disabled={pending}
            aria-pressed={reviewed}
            onClick={() =>
              start(async () => {
                await setCatalogDraftReviewed(!reviewed);
                router.refresh();
              })
            }
          >
            {reviewed ? "Reviewed by Kai" : "Mark reviewed by Kai"}
          </Button>
        </div>
      </Panel>
    </section>
  );
}
