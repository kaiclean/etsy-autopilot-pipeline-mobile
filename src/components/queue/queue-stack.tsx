"use client";

import { AlertTriangle, Check, CheckCheck, Pencil, Search, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { bulkSetListingStatus, setListingStatus } from "@/app/actions";
import { EmptyState, NicheTag, Panel, Thumb } from "@/components/common";
import { ProvenanceBadge } from "@/components/provenance-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Listing, Niche } from "@/db/schema";
import { filterQueue, listingHasErrors, QUEUE_TRIAGE, titleImageMismatch, type QueueStatusFilter, type QueueTriage } from "@/lib/catalog-filters";
import { productLabel } from "@/lib/fees";
import { listingProvenance } from "@/lib/provenance";
import { chf } from "@/lib/format";
import { NICHE_LIST } from "@/lib/niches";
import { cn } from "@/lib/utils";
import { ListingEditor } from "./listing-editor";

const THRESHOLD = 100;
type Decision = "approved" | "rejected";

function vibrate(ms: number) {
  if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate?.(ms);
}

export function QueueStack({
  listings,
  offsiteAds,
  usdToChf,
  initialTriage = "all",
}: {
  listings: Listing[];
  offsiteAds: boolean;
  usdToChf?: number;
  initialTriage?: QueueTriage;
}) {
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<Listing | null>(null);
  const [exit, setExit] = useState<{ id: number; dir: 1 | -1 } | null>(null);
  const [drag, setDrag] = useState({ x: 0, y: 0, active: false });
  const [query, setQuery] = useState("");
  const [niche, setNiche] = useState<"all" | Niche>("all");
  const [status, setStatus] = useState<QueueStatusFilter>("all");
  const [triage, setTriage] = useState<QueueTriage>(initialTriage);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const startRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const remaining = listings.filter((l) => !hidden.has(l.id));
  const visible = useMemo(() => filterQueue(remaining, { query, niche, status, triage }), [remaining, query, niche, status, triage]);
  const top = visible[0];
  const selectedVisible = visible.filter((l) => selected.has(l.id));
  const hasErrors = (l: Listing) => listingHasErrors(l.validation);

  const hide = useCallback((id: number, on: boolean) => {
    setHidden((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  }, []);

  const toggleSelected = useCallback((id: number) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const decide = useCallback(
    async (l: Listing, d: Decision) => {
      if (d === "approved" && hasErrors(l)) {
        vibrate(30);
        toast.warning("Fix validation issues before approving", { description: l.validation.find((i) => i.severity === "error")?.message });
        setEditing(l);
        return;
      }
      vibrate(12);
      setExit({ id: l.id, dir: d === "approved" ? 1 : -1 });
      setTimeout(() => {
        hide(l.id, true);
        setExit(null);
        setDrag({ x: 0, y: 0, active: false });
      }, 220);
      const r = await setListingStatus(l.id, d);
      if (!r.ok) {
        hide(l.id, false);
        toast.error(r.error);
        return;
      }
      toast.success(d === "approved" ? "Approved: publishes on next run" : "Rejected", {
        description: l.title.slice(0, 60),
        action: {
          label: "Undo",
          onClick: async () => {
            await setListingStatus(l.id, "pending_approval");
            hide(l.id, false);
          },
        },
      });
    },
    [],
  );

  const bulk = useCallback(
    async (decision: Decision) => {
      const ids = visible.filter((listing) => selected.has(listing.id)).map((listing) => listing.id);
      if (ids.length === 0) {
        toast.message("Select listings first");
        return;
      }
      const result = await bulkSetListingStatus(ids, decision);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      if (result.changed.length === 0) {
        toast.warning("Nothing changed", { description: result.skipped[0]?.error ?? "Fix validation before approving" });
        return;
      }
      for (const id of result.changed) hide(id, true);
      setSelected(new Set());
      const verb = decision === "approved" ? "Approved" : "Rejected";
      toast.success(result.skipped.length ? `${verb} ${result.changed.length}, skipped ${result.skipped.length}` : `${verb} ${result.changed.length}`, {
        description: result.skipped[0]?.error,
        action: {
          label: "Undo",
          onClick: async () => {
            await bulkSetListingStatus(result.changed, "pending_approval");
            for (const id of result.changed) hide(id, false);
          },
        },
      });
    },
    [visible, selected, hide],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editing || (e.target as HTMLElement)?.closest("input,textarea,select")) return;
      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.key === "X" || e.key === "x") {
        if (top) toggleSelected(top.id);
        return;
      }
      if (e.shiftKey && (e.key === "A" || e.key === "a")) {
        e.preventDefault();
        void bulk("approved");
        return;
      }
      if (e.shiftKey && (e.key === "R" || e.key === "r")) {
        e.preventDefault();
        void bulk("rejected");
        return;
      }
      if (!top) return;
      if (e.key === "ArrowRight") decide(top, "approved");
      if (e.key === "ArrowLeft") decide(top, "rejected");
      if (e.key.toLowerCase() === "e") setEditing(top);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [top, editing, decide, bulk, toggleSelected]);

  if (remaining.length === 0) {
    return (
      <EmptyState
        icon={CheckCheck}
        title="Queue cleared"
        body="Every listing has been reviewed. New drafts appear here after the Listing stage runs."
        action={
          <Link href="/pipeline">
            <Button variant="secondary" className="h-10 rounded-xl">Open pipeline</Button>
          </Link>
        }
      />
    );
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button,a")) return;
    startRef.current = { x: e.clientX, y: e.clientY, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ x: 0, y: 0, active: true });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const s = startRef.current;
    if (!s) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (Math.abs(dx) > 6) s.moved = true;
    setDrag({ x: dx, y: dy * 0.2, active: true });
  };
  const onPointerUp = () => {
    const s = startRef.current;
    startRef.current = null;
    if (!s || !top) return;
    if (drag.x > THRESHOLD) decide(top, "approved");
    else if (drag.x < -THRESHOLD) decide(top, "rejected");
    else {
      if (!s.moved) setEditing(top);
      setDrag({ x: 0, y: 0, active: false });
    }
  };

  const exiting = Boolean(top && exit?.id === top.id);
  const x = exiting && exit ? exit.dir * 600 : drag.x;
  const rot = x / 18;
  const approveOpacity = Math.min(1, Math.max(0, x / THRESHOLD));
  const rejectOpacity = Math.min(1, Math.max(0, -x / THRESHOLD));
  const next = visible[1];
  const errors = top ? top.validation.filter((i) => i.severity === "error") : [];

  const clearFilters = () => {
    setQuery("");
    setNiche("all");
    setStatus("all");
    setTriage("all");
  };

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search title or tags"
            aria-label="Search queue"
            className="h-10 rounded-xl pl-9"
          />
        </div>
        <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 md:mx-0 md:px-0">
          <QueueChip active={niche === "all"} onClick={() => setNiche("all")} label="All niches" />
          {NICHE_LIST.map((item) => (
            <QueueChip key={item.id} active={niche === item.id} onClick={() => setNiche(item.id)} label={item.short} />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <QueueChip active={status === "all"} onClick={() => setStatus("all")} label="All" />
          <QueueChip active={status === "ready"} onClick={() => setStatus("ready")} label="Ready" />
          <QueueChip active={status === "needs_fixes"} onClick={() => setStatus("needs_fixes")} label="Needs fixes" />
          <span className="ml-auto text-[11px] text-muted-foreground">{visible.length} shown</span>
        </div>
        <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 md:mx-0 md:px-0">
          {QUEUE_TRIAGE.map((item) => (
            <QueueChip key={item.id} active={triage === item.id} onClick={() => setTriage(item.id)} label={item.label} />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="secondary" className="h-9 rounded-xl px-3 text-xs" onClick={() => setSelected(new Set(visible.map((listing) => listing.id)))}>
            Select shown
          </Button>
          <Button type="button" variant="ghost" className="h-9 rounded-xl px-3 text-xs" onClick={() => setSelected(new Set())} disabled={selectedVisible.length === 0}>
            Clear
          </Button>
          <Button type="button" className="h-9 rounded-xl px-3 text-xs" disabled={selectedVisible.length === 0} onClick={() => void bulk("approved")}>
            Approve {selectedVisible.length || ""}
          </Button>
          <Button type="button" variant="destructive" className="h-9 rounded-xl px-3 text-xs" disabled={selectedVisible.length === 0} onClick={() => void bulk("rejected")}>
            Reject {selectedVisible.length || ""}
          </Button>
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Select rows for bulk approve or reject. Invalid listings stay in the queue, and each decision can be undone.
          <span className="hidden md:inline"> Keys: ← reject · → approve · E edit · X select · Shift+A approve selected · Shift+R reject selected · / search.</span>
        </p>
      </div>

      {!top ? (
        <EmptyState
          icon={Search}
          title="No listings match"
          body="Try another niche, status, or search. The rest of the queue is still waiting."
          action={
            <Button variant="secondary" className="h-10 rounded-xl" onClick={clearFilters}>
              Clear filters
            </Button>
          }
        />
      ) : (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,440px)_minmax(0,1fr)]">
      <div className="mx-auto w-full max-w-[440px]">
        <div className="relative">
          {next && (
            <div className="absolute inset-x-3 top-2 bottom-0 scale-[0.97] rounded-3xl border border-border bg-card opacity-60" aria-hidden />
          )}
          <div
            key={top.id}
            role="group"
            aria-label={`Review ${top.title}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            style={{
              transform: `translate3d(${x}px, ${drag.y}px, 0) rotate(${rot}deg)`,
              transition: drag.active && !exiting ? "none" : "transform 220ms cubic-bezier(.2,.8,.2,1)",
              touchAction: "pan-y",
            }}
            className="relative cursor-grab overflow-hidden rounded-3xl border border-border bg-card shadow-2xl shadow-black/40 select-none active:cursor-grabbing"
          >
            <div className="relative">
              <Thumb src={top.imageUrl} alt={top.title} className="pointer-events-none h-[34dvh] max-h-[380px] min-h-[220px] w-full rounded-none" />
              <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-card via-transparent to-transparent" />
              <span
                style={{ opacity: approveOpacity }}
                className="pointer-events-none absolute top-5 left-5 -rotate-12 rounded-xl border-[3px] border-success px-3 py-1 text-2xl font-black tracking-wider text-success"
              >
                APPROVE
              </span>
              <span
                style={{ opacity: rejectOpacity }}
                className="pointer-events-none absolute top-5 right-5 rotate-12 rounded-xl border-[3px] border-destructive px-3 py-1 text-2xl font-black tracking-wider text-destructive"
              >
                REJECT
              </span>
              <div className="absolute top-3 left-3 flex gap-1.5" style={{ opacity: 1 - Math.max(approveOpacity, rejectOpacity) }}>
                <ProvenanceBadge kind={listingProvenance(top)} solid />
                <NicheTag niche={top.niche} />
                <span className="inline-flex h-5 items-center rounded-full bg-black/50 px-2 text-[11px] font-medium text-white backdrop-blur">
                  {productLabel(top.productType, top.podProvider)}
                </span>
              </div>
            </div>
            <div className="space-y-3 p-4 pt-1">
              <h2 className="line-clamp-2 text-[15px] leading-snug font-semibold">{top.title}</h2>
              <div className="no-scrollbar -mx-4 flex gap-1.5 overflow-x-auto px-4">
                {top.tags.map((t) => (
                  <span key={t} className="shrink-0 rounded-full bg-muted px-2.5 py-1 text-[11px] text-muted-foreground">
                    {t}
                  </span>
                ))}
              </div>
              <div className="grid grid-cols-3 gap-2 rounded-2xl bg-muted/40 p-3">
                <Stat label="Price" value={chf(top.priceChf)} />
                <Stat label="Net / sale" value={chf(top.netChf)} />
                <Stat label="Margin" value={`${top.marginPct.toFixed(0)}%`} good={top.marginPct >= 35} />
              </div>
              {errors.length > 0 && (
                <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive">
                  <AlertTriangle className="mt-px size-4 shrink-0" />
                  <span>
                    {errors[0].message}
                    {errors.length > 1 ? ` (+${errors.length - 1} more)` : ""} Tap to fix.
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="mt-5 flex items-center justify-center gap-5">
          <button
            onClick={() => decide(top, "rejected")}
            aria-label="Reject"
            className="flex size-16 items-center justify-center rounded-full border-2 border-destructive/40 bg-destructive/10 text-destructive transition-transform active:scale-90"
          >
            <X className="size-7" strokeWidth={2.5} />
          </button>
          <button
            onClick={() => setEditing(top)}
            aria-label="Edit"
            className="flex size-12 items-center justify-center rounded-full border border-border bg-card text-foreground transition-transform active:scale-90"
          >
            <Pencil className="size-5" />
          </button>
          <button
            onClick={() => decide(top, "approved")}
            aria-label="Approve"
            className={cn(
              "flex size-16 items-center justify-center rounded-full transition-transform active:scale-90",
              errors.length ? "border-2 border-border bg-muted text-muted-foreground" : "bg-primary text-primary-foreground shadow-lg shadow-primary/30",
            )}
          >
            <Check className="size-7" strokeWidth={2.75} />
          </button>
        </div>
        <p className="mt-3 text-center text-[11px] text-muted-foreground">
          Swipe right to approve, left to reject, tap to edit
        </p>
      </div>

      <div>
        <div className="mb-2.5 text-[13px] font-semibold tracking-wide text-muted-foreground uppercase">In this filter · {visible.length}</div>
        <Panel className="divide-y divide-border">
          {visible.map((l) => (
            <div key={l.id} className={cn("flex w-full items-center gap-3 p-3", l.id === top.id && "bg-muted/30")}>
              <input
                type="checkbox"
                checked={selected.has(l.id)}
                onChange={() => toggleSelected(l.id)}
                aria-label={`Select ${l.title}`}
                className="size-4 shrink-0 accent-primary"
              />
              <button type="button" onClick={() => setEditing(l)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                <Thumb src={l.imageUrl} alt="" className="size-12 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{l.title}</div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                    <NicheTag niche={l.niche} /> {chf(l.priceChf)} · net {chf(l.netChf)}
                    {hasErrors(l) && <span className="text-destructive">· needs fixes</span>}
                    {titleImageMismatch(l) && <span className="text-warning">· title/image mismatch</span>}
                    {!l.etsyListingId && l.imageUrl && <span>· no Etsy id</span>}
                    {l.id === top.id && <span>· reviewing</span>}
                  </div>
                </div>
              </button>
            </div>
          ))}
        </Panel>
      </div>
    </div>
      )}

      <ListingEditor
        listing={editing}
        open={Boolean(editing)}
        offsiteAds={offsiteAds}
        usdToChf={usdToChf}
        onOpenChange={(o) => !o && setEditing(null)}
        onApproved={(id) => hide(id, true)}
      />
    </div>
  );
}

function QueueChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
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

function Stat({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return (
    <div>
      <div className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">{label}</div>
      <div className={cn("tabular mt-0.5 text-[15px] font-semibold", good === true && "text-success", good === false && "text-warning")}>{value}</div>
    </div>
  );
}
