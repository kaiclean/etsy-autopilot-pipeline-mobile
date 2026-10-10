"use client";

import { Clock, ScrollText } from "lucide-react";
import { useOptimistic, useState, useTransition } from "react";
import { setStagePaused } from "@/app/actions";
import { Panel, STAGE_ICONS } from "@/components/common";
import { RunStageButton } from "@/components/run-button";
import { Button } from "@/components/ui/button";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { Switch } from "@/components/ui/switch";
import type { JobRun, StageName } from "@/db/schema";
import { describeCron, nextRun } from "@/lib/cron";
import { relTime } from "@/lib/format";
import { cn } from "@/lib/utils";

type Props = {
  id: StageName;
  label: string;
  description: string;
  settings: { paused: boolean; cron: string };
  runs: JobRun[];
  killSwitch: boolean;
};

function untilLabel(d: Date) {
  const m = Math.max(1, Math.round((d.getTime() - Date.now()) / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

const STATUS_CLS: Record<JobRun["status"], string> = {
  success: "bg-success/15 text-success",
  warning: "bg-warning/15 text-warning",
  failed: "bg-destructive/15 text-destructive",
  running: "bg-chart-4/15 text-chart-4",
  skipped: "bg-warning/15 text-warning",
};

export function StageCard({ id, label, description, settings, runs, killSwitch }: Props) {
  const Icon = STAGE_ICONS[id];
  const last = runs[0];
  const [paused, setPausedOptimistic] = useOptimistic(settings.paused);
  const [, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [forceRun, setForceRun] = useState(false);
  const next = nextRun(settings.cron);

  return (
    <Panel className={cn("flex flex-col p-4", (paused || killSwitch) && "opacity-80")}>
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted">
          <Icon className="size-[18px]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold">{label}</h3>
            {last && <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-bold uppercase", STATUS_CLS[last.status])}>{last.status}</span>}
          </div>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <label className="flex flex-col items-center gap-1 text-[10px] font-medium text-muted-foreground">
          <Switch
            checked={!paused}
            aria-label={`${label} automation`}
            onCheckedChange={(on) =>
              start(async () => {
                setPausedOptimistic(!on);
                await setStagePaused(id, !on);
              })
            }
          />
          {paused ? "Paused" : "Auto"}
        </label>
      </div>

      <div className="mt-3 rounded-xl bg-muted/40 px-3 py-2.5 text-xs">
        <p className="line-clamp-2 min-h-8 text-foreground/90">{last?.summary ?? "Not run yet."}</p>
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
          <span suppressHydrationWarning>Last: {last ? `${relTime(last.startedAt)} · ${last.trigger}` : "never"}</span>
          <span className="flex items-center gap-1">
            <Clock className="size-3" />
            {describeCron(settings.cron)}
            {next && !paused && !killSwitch ? <span suppressHydrationWarning> · next in {untilLabel(next)}</span> : null}
          </span>
        </div>
      </div>

      <div className="mt-3 flex flex-col gap-2">
        <div className="flex gap-2">
          <RunStageButton stage={id} label="Run now" force={id === "daily" && forceRun} disabled={killSwitch} className="flex-1" />
          <Button variant="outline" size="lg" className="h-10 rounded-xl px-3.5" onClick={() => setOpen(true)}>
            <ScrollText className="size-4" /> Logs
          </Button>
        </div>
        {id === "daily" && (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="size-3.5 accent-current"
              checked={forceRun}
              onChange={(event) => setForceRun(event.target.checked)}
            />
            Force (?force=1) even if today’s chain already succeeded
          </label>
        )}
      </div>

      <Drawer open={open} onOpenChange={setOpen} showSwipeHandle>
        <DrawerContent className="md:mx-auto md:max-w-2xl">
          <DrawerHeader className="text-left">
            <DrawerTitle>{label} · recent runs</DrawerTitle>
          </DrawerHeader>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 pb-[calc(env(safe-area-inset-bottom)+16px)]">
            {runs.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">No runs yet.</p>}
            {runs.map((r) => (
              <div key={r.id} className="rounded-xl border border-border p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-bold uppercase", STATUS_CLS[r.status])}>{r.status}</span>
                  <span className="text-[11px] text-muted-foreground" suppressHydrationWarning>
                    {new Date(r.startedAt).toLocaleString("de-CH", { timeZone: "Europe/Zurich" })} · {r.trigger}
                    {r.finishedAt ? ` · ${((new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()) / 1000).toFixed(1)}s` : ""}
                  </span>
                </div>
                <p className="mt-2 text-sm">{r.summary}</p>
                {r.logs.length > 0 && (
                  <pre className="mt-2 max-h-56 overflow-auto rounded-lg bg-black/40 p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
                    {r.logs.map((l) => `${l.t.slice(11, 19)} ${l.level === "info" ? " " : l.level === "warn" ? "!" : "✗"} ${l.msg}`).join("\n")}
                  </pre>
                )}
              </div>
            ))}
          </div>
        </DrawerContent>
      </Drawer>
    </Panel>
  );
}
