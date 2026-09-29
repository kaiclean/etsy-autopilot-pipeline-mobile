"use client";

import { AlertTriangle, Check, CheckCheck, Pencil, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { setListingStatus } from "@/app/actions";
import { EmptyState, NicheTag, Panel, Thumb } from "@/components/common";
import { ProvenanceBadge } from "@/components/provenance-badge";
import { Button } from "@/components/ui/button";
import type { Listing } from "@/db/schema";
import { productLabel } from "@/lib/fees";
import { listingProvenance } from "@/lib/provenance";
import { chf } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ListingEditor } from "./listing-editor";

const THRESHOLD = 100;
type Decision = "approved" | "rejected";

function vibrate(ms: number) {
  if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate?.(ms);
}

export function QueueStack({ listings, offsiteAds }: { listings: Listing[]; offsiteAds: boolean }) {
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<Listing | null>(null);
  const [exit, setExit] = useState<{ id: number; dir: 1 | -1 } | null>(null);
  const [drag, setDrag] = useState({ x: 0, y: 0, active: false });
  const startRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  const visible = listings.filter((l) => !hidden.has(l.id));
  const top = visible[0];
  const hasErrors = (l: Listing) => l.validation.some((i) => i.severity === "error");

  const hide = (id: number, on: boolean) =>
    setHidden((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!top || editing || (e.target as HTMLElement)?.closest("input,textarea")) return;
      if (e.key === "ArrowRight") decide(top, "approved");
      if (e.key === "ArrowLeft") decide(top, "rejected");
      if (e.key.toLowerCase() === "e") setEditing(top);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [top, editing, decide]);

  if (!top) {
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
    if (!s) return;
    if (drag.x > THRESHOLD) decide(top, "approved");
    else if (drag.x < -THRESHOLD) decide(top, "rejected");
    else {
      if (!s.moved) setEditing(top);
      setDrag({ x: 0, y: 0, active: false });
    }
  };

  const exiting = exit?.id === top.id;
  const x = exiting ? exit!.dir * 600 : drag.x;
  const rot = x / 18;
  const approveOpacity = Math.min(1, Math.max(0, x / THRESHOLD));
  const rejectOpacity = Math.min(1, Math.max(0, -x / THRESHOLD));
  const next = visible[1];
  const errors = top.validation.filter((i) => i.severity === "error");

  return (
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
          <span className="hidden md:inline"> · keys ← → E</span>
        </p>
      </div>

      <div className="hidden lg:block">
        <div className="mb-2.5 text-[13px] font-semibold tracking-wide text-muted-foreground uppercase">Up next · {visible.length - 1}</div>
        <Panel className="divide-y divide-border">
          {visible.slice(1).map((l) => (
            <button key={l.id} onClick={() => setEditing(l)} className="flex w-full items-center gap-3 p-3 text-left hover:bg-muted/40">
              <Thumb src={l.imageUrl} alt="" className="size-12 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{l.title}</div>
                <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                  <NicheTag niche={l.niche} /> {chf(l.priceChf)} · net {chf(l.netChf)}
                  {hasErrors(l) && <span className="text-destructive">· needs fixes</span>}
                </div>
              </div>
            </button>
          ))}
          {visible.length === 1 && <p className="p-4 text-sm text-muted-foreground">This is the last one.</p>}
        </Panel>
      </div>

      <ListingEditor
        listing={editing}
        open={Boolean(editing)}
        offsiteAds={offsiteAds}
        onOpenChange={(o) => !o && setEditing(null)}
        onApproved={(id) => hide(id, true)}
      />
    </div>
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
