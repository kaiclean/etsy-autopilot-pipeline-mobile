"use client";

import { Bell, BellOff, Loader2, Moon, Power, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useOptimistic, useState, useSyncExternalStore, useTransition } from "react";
import { toast } from "sonner";
import { saveAutomation, setKillSwitch, setStagePaused } from "@/app/actions";
import { Panel, STAGE_ICONS } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { StageName } from "@/db/schema";
import { describeCron } from "@/lib/cron";
import type { AutomationSettings, StageSettings } from "@/lib/settings";
import { STAGES } from "@/pipeline/types";
import { cn } from "@/lib/utils";

const noopSubscribe = () => () => {};

export function KillSwitchCard({ on }: { on: boolean }) {
  const [optimistic, setOptimistic] = useOptimistic(on);
  const [pending, start] = useTransition();
  return (
    <Panel className={cn("p-4 transition-colors", optimistic ? "border-destructive/50 bg-destructive/10" : "")}>
      <div className="flex items-center gap-4">
        <div className={cn("flex size-12 items-center justify-center rounded-2xl", optimistic ? "bg-destructive text-white" : "bg-muted")}>
          <Power className="size-6" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-semibold">Kill switch</div>
          <div className="text-xs text-muted-foreground">
            {optimistic ? "All automation paused: no generation, publishing or syncing." : "Automation running on schedule."}
          </div>
        </div>
        <Button
          variant={optimistic ? "default" : "destructive"}
          disabled={pending}
          className="h-11 rounded-xl px-4 font-semibold"
          onClick={() =>
            start(async () => {
              setOptimistic(!optimistic);
              await setKillSwitch(!optimistic);
              toast[!optimistic ? "error" : "success"](!optimistic ? "Automation paused" : "Automation resumed");
            })
          }
        >
          {pending ? <Loader2 className="animate-spin" /> : optimistic ? "Resume" : "Pause all"}
        </Button>
      </div>
    </Panel>
  );
}

type NumKey = "dailyAiCapChf" | "monthlyAiBudgetChf" | "dailyAdsCapChf" | "targetMarginPct" | "designsPerRun";
const FIELDS: { key: NumKey; label: string; hint: string; suffix: string; step: string }[] = [
  { key: "dailyAiCapChf", label: "Daily AI spend cap", hint: "Design stage stops when reached", suffix: "CHF", step: "0.5" },
  { key: "monthlyAiBudgetChf", label: "Monthly AI budget", hint: "Hard stop for image + text generation", suffix: "CHF", step: "1" },
  { key: "dailyAdsCapChf", label: "Etsy Ads daily budget", hint: "Tracked here; set the same value in Etsy", suffix: "CHF", step: "0.01" },
  { key: "targetMarginPct", label: "Target net margin", hint: "Used for price suggestions", suffix: "%", step: "1" },
  { key: "designsPerRun", label: "Designs per run", hint: "Keywords picked per Research/Design run", suffix: "", step: "1" },
];

export function BudgetsForm({ automation }: { automation: AutomationSettings }) {
  const [values, setValues] = useState(() => Object.fromEntries(FIELDS.map((f) => [f.key, String(automation[f.key])])) as Record<NumKey, string>);
  const [adsEnabled, setAdsEnabled] = useState(automation.adsEnabled);
  const [offsite, setOffsite] = useState(automation.assumeOffsiteAds);
  const [pending, start] = useTransition();
  const dirty =
    FIELDS.some((f) => Number(values[f.key]) !== automation[f.key]) || adsEnabled !== automation.adsEnabled || offsite !== automation.assumeOffsiteAds;

  return (
    <Panel className="divide-y divide-border">
      {FIELDS.map((f) => (
        <label key={f.key} className="flex items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{f.label}</div>
            <div className="text-[11px] text-muted-foreground">{f.hint}</div>
          </div>
          <div className="relative w-28">
            <Input
              inputMode="decimal"
              type="number"
              step={f.step}
              min={0}
              value={values[f.key]}
              onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
              className={cn("tabular h-10 rounded-xl text-right", f.suffix && "pr-11")}
            />
            {f.suffix && <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs text-muted-foreground">{f.suffix}</span>}
          </div>
        </label>
      ))}
      <label className="flex items-center gap-3 px-4 py-3">
        <div className="flex-1">
          <div className="text-sm font-medium">Etsy Ads running</div>
          <div className="text-[11px] text-muted-foreground">Books the daily budget as a cost (no Ads API: manage in Etsy)</div>
        </div>
        <Switch checked={adsEnabled} onCheckedChange={setAdsEnabled} />
      </label>
      <label className="flex items-center gap-3 px-4 py-3">
        <div className="flex-1">
          <div className="text-sm font-medium">Price for Offsite Ads</div>
          <div className="text-[11px] text-muted-foreground">Include the 15% Offsite Ads fee in suggested prices</div>
        </div>
        <Switch checked={offsite} onCheckedChange={setOffsite} />
      </label>
      <div className="flex justify-end p-3">
        <Button
          disabled={!dirty || pending}
          className="h-10 rounded-xl px-5"
          onClick={() =>
            start(async () => {
              await saveAutomation({
                ...(Object.fromEntries(FIELDS.map((f) => [f.key, Number(values[f.key])])) as Partial<AutomationSettings>),
                adsEnabled,
                assumeOffsiteAds: offsite,
              });
              toast.success("Budgets saved");
            })
          }
        >
          {pending ? <Loader2 className="animate-spin" /> : "Save budgets"}
        </Button>
      </div>
    </Panel>
  );
}

export function SchedulesList({ stages }: { stages: StageSettings }) {
  return (
    <Panel className="divide-y divide-border">
      {STAGES.map((s) => (
        <ScheduleRow key={s.id} id={s.id} label={s.label} cron={stages[s.id].cron} paused={stages[s.id].paused} />
      ))}
    </Panel>
  );
}

function ScheduleRow({ id, label, cron, paused }: { id: StageName; label: string; cron: string; paused: boolean }) {
  const [p, setP] = useOptimistic(paused);
  const [, start] = useTransition();
  const Icon = STAGE_ICONS[id];
  return (
    <label className="flex items-center gap-3 px-4 py-3">
      <Icon className="size-4 text-muted-foreground" />
      <div className="flex-1">
        <div className="text-sm font-medium">{label}</div>
        <div className="font-mono text-[11px] text-muted-foreground">
          {describeCron(cron)} · <span className="opacity-70">{cron}</span>
        </div>
      </div>
      <Switch
        checked={!p}
        onCheckedChange={(on) =>
          start(async () => {
            setP(!on);
            await setStagePaused(id, !on);
          })
        }
      />
    </label>
  );
}

export function NotificationsCard() {
  const browserPerm = useSyncExternalStore(
    noopSubscribe,
    () => (typeof Notification === "undefined" ? "unsupported" : Notification.permission),
    () => "default" as const,
  );
  const [requested, setPerm] = useState<NotificationPermission | null>(null);
  const perm = requested ?? browserPerm;
  const enable = async () => {
    if (typeof Notification === "undefined") return;
    if ("serviceWorker" in navigator) await navigator.serviceWorker.register("/sw.js").catch(() => {});
    const r = await Notification.requestPermission();
    setPerm(r);
    if (r === "granted") {
      const reg = await navigator.serviceWorker?.getRegistration();
      const opts = { body: "You'll be notified about new orders and items awaiting approval.", icon: "/icons/192" };
      if (reg) reg.showNotification("Notifications on", opts);
      else new Notification("Notifications on", opts);
    }
  };
  return (
    <Panel className="flex items-center gap-3 p-4">
      <div className="flex size-10 items-center justify-center rounded-xl bg-muted">
        {perm === "granted" ? <Bell className="size-5 text-success" /> : <BellOff className="size-5 text-muted-foreground" />}
      </div>
      <div className="flex-1">
        <div className="text-sm font-medium">Order &amp; approval notifications</div>
        <div className="text-[11px] text-muted-foreground">
          {perm === "granted"
            ? "On. Delivered while the app is open or installed in the background."
            : perm === "denied"
              ? "Blocked in browser settings."
              : perm === "unsupported"
                ? "Not supported here. On iPhone, add to Home Screen first."
                : "Get a ping for new orders and listings awaiting approval."}
        </div>
      </div>
      {perm === "default" && (
        <Button className="h-10 rounded-xl" onClick={enable}>
          Enable
        </Button>
      )}
    </Panel>
  );
}

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const dark = !mounted || theme !== "light";
  return (
    <Panel className="flex items-center gap-3 p-4">
      <div className="flex size-10 items-center justify-center rounded-xl bg-muted">{dark ? <Moon className="size-5" /> : <Sun className="size-5" />}</div>
      <div className="flex-1 text-sm font-medium">Dark mode</div>
      <Switch checked={dark} onCheckedChange={(on) => setTheme(on ? "dark" : "light")} />
    </Panel>
  );
}

export function EtsyStatusToast({ status }: { status?: string }) {
  useEffect(() => {
    if (!status) return;
    const msg: Record<string, [string, "success" | "error"]> = {
      connected: ["Etsy shop connected", "success"],
      denied: ["Etsy authorization was cancelled", "error"],
      "invalid-state": ["Etsy OAuth state mismatch. Try again.", "error"],
      "token-error": ["Could not exchange Etsy token. Check keys and redirect URI.", "error"],
      "missing-key": ["Set ETSY_API_KEY first", "error"],
    };
    const m = msg[status];
    if (m) toast[m[1]](m[0]);
  }, [status]);
  return null;
}
