"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { draftBusinessPins, setActiveBusiness, setBusinessKillSwitch, setBusinessPublishMode, setBusinessSpendCap } from "@/app/actions";
import { Panel } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { BusinessCard } from "@/lib/businesses";
import { GO_LIVE_CONFIRMATION } from "@/lib/publish-mode";
import { effectiveBusinessCap } from "@/lib/spend-cap";

export function BusinessBoard({ cards, globalCap }: { cards: BusinessCard[]; globalCap: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const active = cards.find((card) => card.active) ?? cards[0];

  const refresh = () => router.refresh();

  return (
    <div className="space-y-4" data-testid="business-list">
      <Panel className="flex flex-wrap items-center gap-3 p-4">
        <label className="text-sm font-medium" htmlFor="business-switcher">
          Business
        </label>
        <select
          id="business-switcher"
          data-testid="business-switcher"
          className="h-10 min-w-48 rounded-xl border border-border bg-background px-3 text-sm"
          value={active?.id ?? ""}
          disabled={pending}
          onChange={(event) => {
            const id = event.target.value;
            start(async () => {
              const result = await setActiveBusiness(id);
              if (!result.ok) {
                toast.error(result.error);
                return;
              }
              toast.success(`Switched to ${result.displayName}`);
              refresh();
            });
          }}
        >
          {cards.map((card) => (
            <option key={card.id} value={card.id}>
              {card.displayName} ({card.kind})
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">Global AI cap {globalCap.toFixed(2)} CHF still applies on top of each business.</p>
      </Panel>

      <div className="grid gap-3">
        {cards.map((card) => (
          <BusinessCardView key={card.id} card={card} globalCap={globalCap} pending={pending} start={start} refresh={refresh} />
        ))}
      </div>
    </div>
  );
}

function BusinessCardView({
  card,
  globalCap,
  pending,
  start,
  refresh,
}: {
  card: BusinessCard;
  globalCap: number;
  pending: boolean;
  start: (fn: () => void) => void;
  refresh: () => void;
}) {
  const [cap, setCap] = useState(card.dailyAiCapChf == null ? "" : String(card.dailyAiCapChf));
  const [confirmation, setConfirmation] = useState("");
  const effective = effectiveBusinessCap(card.dailyAiCapChf, globalCap);

  return (
    <Panel className="space-y-3 p-4" data-testid={`business-${card.slug}`} data-kind={card.kind} data-active={card.active ? "true" : "false"}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">
            {card.displayName}
            {card.businessNumber ? <span className="ml-2 text-xs font-medium text-muted-foreground">Business #{card.businessNumber}</span> : null}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {card.kind}
            {card.parentName ? ` · parent ${card.parentName}` : ""} · {card.slug}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5 text-[10px] font-semibold tracking-wide">
          <span className="rounded-full bg-muted px-2 py-1" data-testid={`${card.slug}-status`}>{card.status}</span>
          <span className="rounded-full bg-muted px-2 py-1" data-testid={`${card.slug}-mode`}>{card.publishMode}</span>
          <span className="rounded-full bg-muted px-2 py-1" data-testid={`${card.slug}-kill`}>{card.killSwitch ? "Kill on" : "Kill off"}</span>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Spend cap {card.dailyAiCapChf == null ? `uses global ${globalCap.toFixed(2)}` : `${card.dailyAiCapChf.toFixed(2)} CHF`} · effective {effective.toFixed(2)} CHF
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-muted-foreground">
          Daily AI cap (CHF)
          <Input value={cap} onChange={(event) => setCap(event.target.value)} inputMode="decimal" className="mt-1 h-10 w-32 rounded-xl" />
        </label>
        <Button
          variant="secondary"
          className="h-10 rounded-xl"
          disabled={pending}
          onClick={() => {
            const trimmed = cap.trim();
            const next = trimmed === "" ? null : Number(trimmed);
            start(async () => {
              const result = await setBusinessSpendCap(card.id, next);
              if (!result.ok) {
                toast.error(result.error);
                return;
              }
              toast.success("Spend cap saved");
              refresh();
            });
          }}
        >
          Save cap
        </Button>
        <Button
          variant={card.killSwitch ? "secondary" : "destructive"}
          className="h-10 rounded-xl"
          disabled={pending}
          onClick={() => {
            start(async () => {
              const result = await setBusinessKillSwitch(card.id, !card.killSwitch);
              if (!result.ok) {
                toast.error(result.error);
                return;
              }
              toast.success(card.killSwitch ? "Kill switch off" : "Kill switch on");
              refresh();
            });
          }}
        >
          {pending ? <Loader2 className="animate-spin" /> : card.killSwitch ? "Resume business" : "Kill switch"}
        </Button>
        {card.kind === "pinterest" ? (
          <Button
            className="h-10 rounded-xl"
            disabled={pending}
            onClick={() => {
              start(async () => {
                const result = await draftBusinessPins(card.id);
                if (!result.ok) {
                  toast.error(result.error);
                  return;
                }
                toast.success(result.summary ?? "Pins drafted");
                refresh();
              });
            }}
          >
            Draft pins
          </Button>
        ) : null}
      </div>

      {card.kind === "etsy" ? (
        <p className="text-xs text-muted-foreground">Etsy go-live stays on Connections. Type {GO_LIVE_CONFIRMATION} there. This page does not change Etsy publishing.</p>
      ) : card.publishMode === "live" ? (
        <Button
          variant="secondary"
          className="h-10 rounded-xl"
          disabled={pending}
          onClick={() => {
            start(async () => {
              const result = await setBusinessPublishMode(card.id, "dry-run");
              if (!result.ok) {
                toast.error(result.error);
                return;
              }
              toast.success("Back to dry-run");
              refresh();
            });
          }}
        >
          Return to dry-run
        </Button>
      ) : (
        <div className="space-y-2 border-t border-border pt-3">
          <label className="block text-xs text-muted-foreground">
            Type {GO_LIVE_CONFIRMATION} to mark this business live
            <Input
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="mt-1.5 h-10 max-w-xs rounded-xl font-mono"
              placeholder={GO_LIVE_CONFIRMATION}
              data-testid={`${card.slug}-confirm`}
            />
          </label>
          <Button
            variant="destructive"
            className="h-10 rounded-xl"
            disabled={pending || confirmation !== GO_LIVE_CONFIRMATION}
            onClick={() => {
              start(async () => {
                const result = await setBusinessPublishMode(card.id, "live", confirmation);
                if (!result.ok) {
                  toast.error(result.error);
                  return;
                }
                toast.success("Business confirmed live");
                setConfirmation("");
                refresh();
              });
            }}
          >
            Confirm live
          </Button>
        </div>
      )}
    </Panel>
  );
}
