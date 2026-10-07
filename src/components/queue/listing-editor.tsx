"use client";

import { AlertCircle, Check, Loader2, Plus, X } from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { updateListing } from "@/app/actions";
import { FeeBreakdown } from "@/components/fee-breakdown";
import { Button } from "@/components/ui/button";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { Listing } from "@/db/schema";
import { calculateFees } from "@/lib/fees";
import { validateForPublish } from "@/lib/deliverables";
import { ETSY_LIMITS } from "@/lib/listing-validator";
import { cn } from "@/lib/utils";

type Props = {
  listing: Listing | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  offsiteAds?: boolean;
  onApproved?: (id: number) => void;
};

export function ListingEditor({ listing, open, onOpenChange, offsiteAds = false, onApproved }: Props) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange} showSwipeHandle>
      <DrawerContent className="md:mx-auto md:max-w-2xl">
        {listing && <EditorBody key={listing.id} listing={listing} offsiteAds={offsiteAds} onDone={(approved) => {
          onOpenChange(false);
          if (approved) onApproved?.(listing.id);
        }} />}
      </DrawerContent>
    </Drawer>
  );
}

function EditorBody({ listing, offsiteAds, onDone }: { listing: Listing; offsiteAds: boolean; onDone: (approved: boolean) => void }) {
  const [title, setTitle] = useState(listing.title);
  const [tags, setTags] = useState<string[]>(listing.tags);
  const [newTag, setNewTag] = useState("");
  const [price, setPrice] = useState(listing.priceChf.toFixed(2));
  const [description, setDescription] = useState(listing.description);
  const [showDesc, setShowDesc] = useState(false);
  const [pending, start] = useTransition();

  const priceNum = Number(price.replace(",", "."));
  const { issues, valid } = useMemo(
    () =>
      validateForPublish({ title, tags, description, priceChf: priceNum, productType: listing.productType, deliverables: listing.deliverables }),
    [title, tags, description, priceNum, listing.productType, listing.deliverables],
  );
  const fees = useMemo(
    () => calculateFees({ priceChf: Number.isFinite(priceNum) ? priceNum : 0, podCostChf: listing.podCostChf, offsiteAds }),
    [priceNum, listing.podCostChf, offsiteAds],
  );
  const errors = issues.filter((i) => i.severity === "error");

  const addTag = () => {
    const t = newTag.trim().toLowerCase();
    if (!t) return;
    if (!tags.includes(t)) setTags([...tags, t]);
    setNewTag("");
  };

  const save = (approve: boolean) =>
    start(async () => {
      const r = await updateListing(listing.id, { title, tags, priceChf: priceNum, description }, approve);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(approve ? "Saved & approved" : "Changes saved");
      onDone(approve);
    });

  return (
    <>
      <DrawerHeader className="text-left">
        <DrawerTitle>Edit listing</DrawerTitle>
      </DrawerHeader>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 pt-3 pb-4">
        <Field label="Title" counter={`${title.length}/${ETSY_LIMITS.titleMax}`} over={title.length > ETSY_LIMITS.titleMax}>
          <Textarea value={title} onChange={(e) => setTitle(e.target.value)} rows={3} className="min-h-0 resize-none rounded-xl text-[15px]" />
        </Field>

        <Field label="Tags" counter={`${tags.length}/${ETSY_LIMITS.tagCount}`} over={tags.length !== ETSY_LIMITS.tagCount}>
          <div className="flex flex-wrap gap-1.5">
            {tags.map((t) => (
              <span
                key={t}
                className={cn(
                  "inline-flex h-8 items-center gap-1 rounded-full border pr-1 pl-3 text-[13px]",
                  t.length > ETSY_LIMITS.tagMax ? "border-destructive/60 bg-destructive/10 text-destructive" : "border-border bg-muted/50",
                )}
              >
                {t}
                <span className="tabular text-[10px] text-muted-foreground">{t.length}</span>
                <button type="button" aria-label={`Remove ${t}`} onClick={() => setTags(tags.filter((x) => x !== t))} className="flex size-6 items-center justify-center rounded-full hover:bg-muted">
                  <X className="size-3.5" />
                </button>
              </span>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <Input
              value={newTag}
              maxLength={40}
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addTag();
                }
              }}
              placeholder="Add tag (max 20 chars)"
              className="h-10 rounded-xl"
            />
            <Button type="button" variant="secondary" className="h-10 rounded-xl" onClick={addTag} disabled={!newTag.trim()}>
              <Plus className="size-4" />
            </Button>
          </div>
        </Field>

        <Field label="Price (CHF)">
          <Input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} className="tabular h-11 rounded-xl text-base" />
          <FeeBreakdown fees={fees} className="mt-2" />
        </Field>

        <div>
          <button type="button" className="text-sm font-medium text-primary" onClick={() => setShowDesc((s) => !s)}>
            {showDesc ? "Hide description" : "Edit description (includes required disclosures)"}
          </button>
          {showDesc && <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={10} className="mt-2 rounded-xl text-[13px]" />}
        </div>

        {issues.length > 0 && (
          <ul className="space-y-1.5">
            {issues.map((i, idx) => (
              <li key={idx} className={cn("flex gap-2 text-[13px]", i.severity === "error" ? "text-destructive" : "text-warning")}>
                <AlertCircle className="mt-0.5 size-4 shrink-0" /> {i.message}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2 border-t border-border p-4 pb-[calc(env(safe-area-inset-bottom)+16px)]">
        <Button variant="outline" className="h-12 rounded-xl" disabled={pending} onClick={() => save(false)}>
          Save
        </Button>
        <Button className="h-12 rounded-xl font-semibold" disabled={pending || !valid} onClick={() => save(true)}>
          {pending ? <Loader2 className="animate-spin" /> : <Check className="size-4" />}
          {valid ? "Save & approve" : `${errors.length} issue${errors.length > 1 ? "s" : ""} to fix`}
        </Button>
      </div>
    </>
  );
}

function Field({ label, counter, over, children }: { label: string; counter?: string; over?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[13px] font-semibold">{label}</span>
        {counter && <span className={cn("tabular text-xs", over ? "font-semibold text-destructive" : "text-muted-foreground")}>{counter}</span>}
      </div>
      {children}
    </div>
  );
}
