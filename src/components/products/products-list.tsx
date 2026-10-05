"use client";

import { Eye, Heart, Package, Search, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { activateListing, publishPodListing, readDeliveryFile, savePodSample, verifyDeliveryFile } from "@/app/actions";
import { EmptyState, ListingStatusPill, NicheTag, Panel, Thumb } from "@/components/common";
import { ProvenanceBadge } from "@/components/provenance-badge";
import { FeeBreakdown } from "@/components/fee-breakdown";
import { Button } from "@/components/ui/button";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import type { Listing, Niche } from "@/db/schema";
import { filterProducts, listingHasErrors } from "@/lib/catalog-filters";
import { calculateFees, productLabel } from "@/lib/fees";
import { listingProvenance } from "@/lib/provenance";
import { chf, num, relTime } from "@/lib/format";
import { NICHE_LIST } from "@/lib/niches";
import { cn } from "@/lib/utils";

const FILTERS = [
  { id: "all", label: "All" },
  { id: "published", label: "On Etsy" },
  { id: "pod_created", label: "Printify only" },
  { id: "pending_approval", label: "In review" },
  { id: "approved", label: "Approved" },
  { id: "rejected", label: "Rejected" },
  { id: "failed", label: "Failed" },
] as const;

export function ProductsList({ listings }: { listings: Listing[] }) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("all");
  const [niche, setNiche] = useState<"all" | Niche>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Listing | null>(null);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: listings.length };
    for (const l of listings) c[l.status] = (c[l.status] ?? 0) + 1;
    return c;
  }, [listings]);
  const rows = filterProducts(listings, { query, niche, status: filter });
  const liveDrafts = listings.filter((l) => l.status === "published" && l.publishMode === "live").length;
  const invalid = listings.filter((l) => listingHasErrors(l.validation)).length;

  return (
    <>
      {(liveDrafts > 0 || invalid > 0) && (
        <div className="mb-4 space-y-2">
          {liveDrafts > 0 && (
            <Panel className="flex gap-2 border-warning/30 bg-warning/10 p-3 text-xs text-warning">
              <TriangleAlert className="size-4 shrink-0" />
              <span>
                {liveDrafts} Etsy listing{liveDrafts === 1 ? "" : "s"} still need “How it’s made” set to AI tools in Shop Manager. Activation in this app is per listing, after the delivery file is verified. There is no auto-activate flag.
              </span>
            </Panel>
          )}
          {invalid > 0 && (
            <Panel className="flex gap-2 border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
              <TriangleAlert className="size-4 shrink-0" />
              <span>
                {invalid} listing{invalid === 1 ? "" : "s"} still fail validation, so they cannot be approved or published.
              </span>
            </Panel>
          )}
        </div>
      )}
      <div className="relative mb-3">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search title or tags"
          aria-label="Search products"
          className="h-10 rounded-xl pl-9"
        />
      </div>
      <div className="no-scrollbar -mx-4 mb-3 flex gap-2 overflow-x-auto px-4 md:mx-0 md:px-0">
        <FilterChip active={niche === "all"} onClick={() => setNiche("all")} label="All niches" />
        {NICHE_LIST.map((item) => (
          <FilterChip key={item.id} active={niche === item.id} onClick={() => setNiche(item.id)} label={item.short} />
        ))}
      </div>
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
        <EmptyState
          icon={Package}
          title={listings.length ? "No listings match" : "Nothing here yet"}
          body={listings.length ? "Try another niche, status, or search." : "Listings show up here once the Listing stage has drafted them."}
        />
      ) : (
        <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((l) => (
            <button key={l.id} onClick={() => setSelected(l)} className="flex gap-3 rounded-2xl border border-border bg-card p-3 text-left transition-transform active:scale-[0.99] md:hover:border-foreground/20">
              <Thumb src={l.imageUrl} alt="" className="size-[72px] shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="line-clamp-2 text-[13px] leading-snug font-medium">{l.title}</div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <ProvenanceBadge kind={listingProvenance(l)} />
                  <ListingStatusPill status={l.status} dryRun={l.publishMode === "dry-run"} />
                  <NicheTag niche={l.niche} />
                </div>
                {listingHasErrors(l.validation) && (
                  <div className="mt-1 line-clamp-2 text-[11px] text-destructive">{l.validation.find((issue) => issue.severity === "error")?.message}</div>
                )}
                {l.status === "published" && l.publishMode === "live" && (
                  <div className="mt-1 text-[11px] text-warning">Shop Manager: set How it’s made → AI tools, then activate.</div>
                )}
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

function FilterChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-9 shrink-0 items-center rounded-full border px-3.5 text-[13px] font-medium transition-colors",
        active ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground",
      )}
    >
      {label}
    </button>
  );
}

function HumanPublish({ l }: { l: Listing }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const file = l.fileManifest?.delivery;
  const run = (label: string, action: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      const result = await action();
      if (!result.ok) {
        toast.error(result.error ?? "Could not update the listing");
        return;
      }
      toast.success(label);
      router.refresh();
    });

  if (l.productType === "digital") {
    return (
      <div className="space-y-2 rounded-xl border border-border p-3 text-xs">
        <div className="font-semibold">Delivery file</div>
        {file ? (
          <p className="text-muted-foreground">
            {file.filename} · {file.width}×{file.height}px · {file.bytes} bytes · {file.sha256.slice(0, 12)}
            {l.fileVerifiedAt ? " · verified" : " · not verified"}
            {l.activatedAt ? " · active" : " · draft"}
          </p>
        ) : (
          <p className="text-muted-foreground">No manifest yet. Reading the file records the filename, pixel size, bytes and hash. Activate refuses until you open the file and mark it verified.</p>
        )}
        {file && !l.fileVerifiedAt ? (
          <p className="text-muted-foreground">Mark the file verified after you open it. Mock placeholder art cannot be verified or activated.</p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" className="h-9 rounded-xl" disabled={pending} onClick={() => run("Delivery file recorded", () => readDeliveryFile(l.id))}>
            Read delivery file
          </Button>
          <Button type="button" variant="secondary" className="h-9 rounded-xl" disabled={pending || Boolean(l.fileVerifiedAt)} onClick={() => run("File marked verified", () => verifyDeliveryFile(l.id))}>
            I opened this file
          </Button>
          <Button type="button" className="h-9 rounded-xl" disabled={pending || Boolean(l.activatedAt)} onClick={() => run("Listing activated", () => activateListing(l.id))}>
            Activate
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-xl border border-border p-3 text-xs">
      <div className="font-semibold">Printify</div>
      <p className="text-muted-foreground">
        {l.printifyProductId ? `Product ${l.printifyProductId}` : "No Printify product yet. The publish run creates it and stops there."}
        {l.podBlueprintId ? ` · blueprint ${l.podBlueprintId}` : ""}
        {l.podPrintProviderId ? ` · provider ${l.podPrintProviderId}` : ""}
        {l.podPublishedAt ? " · sent to Etsy" : " · not sent to Etsy"}
      </p>
      {!l.podBlueprintId || !l.podPrintProviderId ? (
        <p className="text-muted-foreground">A sample can be recorded only after a Printify create stores the blueprint id and print provider id.</p>
      ) : l.status !== "pod_created" ? (
        <p className="text-muted-foreground">Publish to Etsy is only for a Printify product that has not been sent yet.</p>
      ) : (
        <p className="text-muted-foreground">Record a physical sample for this blueprint and provider, then publish this listing to Etsy.</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          className="h-9 rounded-xl"
          disabled={pending}
          onClick={() => {
            if (!l.podBlueprintId || !l.podPrintProviderId) {
              toast.error("Blueprint and print provider are not recorded, so a sample cannot be checked.");
              return;
            }
            run("Sample recorded", () => savePodSample(l.podBlueprintId!, l.podPrintProviderId!, "Physical sample approved"));
          }}
        >
          Record sample
        </Button>
        <Button type="button" className="h-9 rounded-xl" disabled={pending || Boolean(l.podPublishedAt)} onClick={() => run("Sent to Etsy", () => publishPodListing(l.id))}>
          Publish to Etsy
        </Button>
      </div>
    </div>
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
            <div className="flex flex-wrap gap-1.5">
              <ProvenanceBadge kind={listingProvenance(l)} />
              <ListingStatusPill status={l.status} dryRun={l.publishMode === "dry-run"} />
            </div>
            <div>{l.productType === "digital" ? "Digital download · Etsy delivers automatically" : `${productLabel(l.productType, l.podProvider)} · Printify`}</div>
            {l.etsyListingId && <div className="font-mono">Etsy: {l.etsyListingId}</div>}
            {l.printifyProductId && <div className="font-mono">Printify: {l.printifyProductId}</div>}
            <div suppressHydrationWarning>Updated {relTime(l.updatedAt)}</div>
            {l.status === "published" && (
              <div className="tabular">{num(l.views)} views · {num(l.favorites)} favorites</div>
            )}
          </div>
        </div>

        {l.status === "published" && l.publishMode === "live" && !l.activatedAt && (
          <div className="flex gap-2 rounded-xl border border-warning/30 bg-warning/10 p-3 text-xs text-warning">
            <TriangleAlert className="size-4 shrink-0" />
            This is an Etsy draft. Set “How it’s made” to AI tools in Shop Manager, then activate it here after the delivery file is verified. The API cannot set that field, and no cron will activate it.
          </div>
        )}
        <HumanPublish l={l} />
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
