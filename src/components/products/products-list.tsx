"use client";

import { Eye, Heart, Package, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { EmptyState, ListingStatusPill, NicheTag, Thumb } from "@/components/common";
import { FeeBreakdown } from "@/components/fee-breakdown";
import { Button } from "@/components/ui/button";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import type { Listing } from "@/db/schema";
import { calculateFees, productLabel } from "@/lib/fees";
import { chf, num, relTime } from "@/lib/format";
import { cn } from "@/lib/utils";

const FILTERS = [
  { id: "all", label: "All" },
  { id: "published", label: "Live" },
  { id: "pending_approval", label: "In review" },
  { id: "approved", label: "Approved" },
  { id: "rejected", label: "Rejected" },
  { id: "failed", label: "Failed" },
] as const;

export function ProductsList({ listings }: { listings: Listing[] }) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("all");
  const [selected, setSelected] = useState<Listing | null>(null);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: listings.length };
    for (const l of listings) c[l.status] = (c[l.status] ?? 0) + 1;
    return c;
  }, [listings]);
  const rows = filter === "all" ? listings : listings.filter((l) => l.status === filter);

  return (
    <>
      <div className="no-scrollbar -mx-4 mb-4 flex gap-2 overflow-x-auto px-4 md:mx-0 md:px-0">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={cn(
              "flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-medium transition-colors",
              filter === f.id ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground",
            )}
          >
            {f.label}
            <span className="tabular text-[11px] opacity-70">{counts[f.id] ?? 0}</span>
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <EmptyState icon={Package} title="Nothing here yet" body="Listings show up here once the Listing stage has drafted them." />
      ) : (
        <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((l) => (
            <button key={l.id} onClick={() => setSelected(l)} className="flex gap-3 rounded-2xl border border-border bg-card p-3 text-left transition-transform active:scale-[0.99] md:hover:border-foreground/20">
              <Thumb src={l.imageUrl} alt="" className="size-[72px] shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="line-clamp-2 text-[13px] leading-snug font-medium">{l.title}</div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <ListingStatusPill status={l.status} dryRun={l.publishMode === "dry-run"} />
                  <NicheTag niche={l.niche} />
                </div>
                <div className="mt-1.5 flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="tabular font-semibold text-foreground">{chf(l.priceChf)}</span>
                  <span className="tabular">net {chf(l.netChf)}</span>
                  {l.status === "published" && (
                    <>
                      <span className="tabular flex items-center gap-0.5"><Eye className="size-3" />{num(l.views)}</span>
                      <span className="tabular flex items-center gap-0.5"><Heart className="size-3" />{num(l.favorites)}</span>
                    </>
                  )}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      <Drawer open={Boolean(selected)} onOpenChange={(o) => !o && setSelected(null)} showSwipeHandle>
        <DrawerContent className="md:mx-auto md:max-w-2xl">
          {selected && <Detail l={selected} />}
        </DrawerContent>
      </Drawer>
    </>
  );
}

function Detail({ l }: { l: Listing }) {
  const fees = calculateFees({ priceChf: l.priceChf, podCostChf: l.podCostChf });
  return (
    <>
      <DrawerHeader className="text-left">
        <DrawerTitle className="line-clamp-2 pr-4">{l.title}</DrawerTitle>
      </DrawerHeader>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 pb-[calc(env(safe-area-inset-bottom)+20px)]">
        <div className="flex gap-3">
          <Thumb src={l.imageUrl} alt="" className="h-32 w-28 shrink-0" />
          <div className="space-y-1.5 text-xs text-muted-foreground">
            <ListingStatusPill status={l.status} dryRun={l.publishMode === "dry-run"} />
            <div>{l.productType === "digital" ? "Digital download · Etsy delivers automatically" : `${productLabel(l.productType, l.podProvider)} · Printify`}</div>
            {l.etsyListingId && <div className="font-mono">Etsy: {l.etsyListingId}</div>}
            {l.printifyProductId && <div className="font-mono">Printify: {l.printifyProductId}</div>}
            <div suppressHydrationWarning>Updated {relTime(l.updatedAt)}</div>
            {l.status === "published" && (
              <div className="tabular">{num(l.views)} views · {num(l.favorites)} favorites</div>
            )}
          </div>
        </div>

        {l.status === "published" && l.publishMode === "live" && (
          <div className="flex gap-2 rounded-xl border border-warning/30 bg-warning/10 p-3 text-xs text-warning">
            <TriangleAlert className="size-4 shrink-0" />
            Etsy draft until you set “How it’s made” → AI tools in Shop Manager and activate it there. The API cannot set that field, so this app leaves listings as drafts.
          </div>
        )}
        {l.publishError && <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">{l.publishError}</div>}
        {l.rejectedReason && <div className="rounded-xl bg-muted p-3 text-xs text-muted-foreground">Rejected: {l.rejectedReason}</div>}

        <FeeBreakdown fees={fees} />

        <div>
          <div className="mb-1.5 text-[13px] font-semibold">Tags ({l.tags.length})</div>
          <div className="flex flex-wrap gap-1.5">
            {l.tags.map((t) => (
              <span key={t} className="rounded-full bg-muted px-2.5 py-1 text-[11px] text-muted-foreground">{t}</span>
            ))}
          </div>
        </div>
        <div>
          <div className="mb-1.5 text-[13px] font-semibold">Description</div>
          <p className="rounded-xl bg-muted/40 p-3 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">{l.description}</p>
        </div>
        {l.status === "pending_approval" && (
          <Link href="/queue">
            <Button className="h-11 w-full rounded-xl">Review in queue</Button>
          </Link>
        )}
      </div>
    </>
  );
}
