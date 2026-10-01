"use client";

import { Bell, BellOff, Loader2, Moon, Power, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useOptimistic, useState, useSyncExternalStore, useTransition } from "react";
import { toast } from "sonner";
import { saveAutomation, savePushPrefs, setKillSwitch, setStagePaused } from "@/app/actions";
import { Panel, STAGE_ICONS } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { StageName } from "@/db/schema";
import { describeCron } from "@/lib/cron";
import { relTime } from "@/lib/format";
import { PUSH_PREF_OPTIONS, type PushPrefKey, type PushPrefs } from "@/lib/push-prefs";
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

export function SchedulesList({
  stages,
  lastRuns,
}: {
  stages: StageSettings;
  lastRuns?: { id: StageName; run: { status: string; startedAt: Date | string } | null }[];
}) {
  const byId = new Map(lastRuns?.map((row) => [row.id, row.run]));
  return (
    <Panel className="divide-y divide-border">
      {STAGES.map((s) => (
        <ScheduleRow key={s.id} id={s.id} label={s.label} cron={stages[s.id].cron} paused={stages[s.id].paused} last={byId.get(s.id) ?? null} />
      ))}
    </Panel>
  );
}

function ScheduleRow({
  id,
  label,
  cron,
  paused,
  last,
}: {
  id: StageName;
  label: string;
  cron: string;
  paused: boolean;
  last: { status: string; startedAt: Date | string } | null;
}) {
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
        <div className="text-[11px] text-muted-foreground" suppressHydrationWarning>
          {last ? `Last ${last.status} · ${relTime(last.startedAt)}` : "Never run"}
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

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function subscribeToPush(publicKey: string) {
  const reg = await navigator.serviceWorker.register("/sw.js");
  const existing = await reg.pushManager.getSubscription();
  const sub =
    existing ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));
  const res = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sub.toJSON()),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? "Could not save the push subscription");
  }
  return true;
}

export function PushEventPrefs({ prefs }: { prefs: PushPrefs }) {
  return (
    <Panel className="divide-y divide-border">
      {PUSH_PREF_OPTIONS.map((option) => (
        <PushPrefRow key={option.key} prefKey={option.key} label={option.label} detail={option.detail} on={prefs[option.key]} />
      ))}
    </Panel>
  );
}

function PushPrefRow({ prefKey, label, detail, on }: { prefKey: PushPrefKey; label: string; detail: string; on: boolean }) {
  const [value, setValue] = useOptimistic(on);
  const [, start] = useTransition();
  return (
    <label className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-[11px] text-muted-foreground">{detail}</div>
      </div>
      <Switch
        checked={value}
        onCheckedChange={(next) =>
          start(async () => {
            setValue(next);
            await savePushPrefs({ [prefKey]: next });
          })
        }
      />
    </label>
  );
}

export function NotificationsCard({ vapidPublicKey }: { vapidPublicKey: string | null }) {
  const browserPerm = useSyncExternalStore(
    noopSubscribe,
    () => (typeof Notification === "undefined" ? "unsupported" : Notification.permission),
    () => "default" as const,
  );
  const [requested, setPerm] = useState<NotificationPermission | null>(null);
  const [pushState, setPushState] = useState<"unknown" | "subscribed" | "unsubscribed">("unknown");
  const [busy, setBusy] = useState(false);
  const perm = requested ?? browserPerm;

  useEffect(() => {
    if (!vapidPublicKey || perm !== "granted" || !("serviceWorker" in navigator)) return;
    let cancel = false;
    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => {
        if (!cancel) setPushState(sub ? "subscribed" : "unsubscribed");
      })
      .catch(() => {
        if (!cancel) setPushState("unsubscribed");
      });
    return () => {
      cancel = true;
    };
  }, [vapidPublicKey, perm]);

  const enable = async () => {
    if (typeof Notification === "undefined") return;
    setBusy(true);
    try {
      if ("serviceWorker" in navigator) await navigator.serviceWorker.register("/sw.js").catch(() => {});
      const r = await Notification.requestPermission();
      setPerm(r);
      if (r !== "granted") return;
      if (vapidPublicKey) {
        await subscribeToPush(vapidPublicKey);
        setPushState("subscribed");
        toast.success("Push notifications on");
      } else {
        const reg = await navigator.serviceWorker?.getRegistration();
        const opts = { body: "You'll be notified about new orders and items awaiting approval.", icon: "/icons/192" };
        if (reg) reg.showNotification("Notifications on", opts);
        else new Notification("Notifications on", opts);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not enable notifications");
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/push/test", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) toast.error(data.error ?? "Test push failed");
      else toast.success("Test push sent");
    } finally {
      setBusy(false);
    }
  };

  const statusLine =
    perm === "granted"
      ? vapidPublicKey
        ? pushState === "subscribed"
          ? "On. This device receives sales and approval pushes, including when the app is closed."
          : "Permission granted. Subscribe this device so pushes arrive when the app is closed."
        : "On while this app is open. Background push needs VAPID keys on the server."
      : perm === "denied"
        ? "Blocked in browser settings."
        : perm === "unsupported"
          ? "Not supported here. On iPhone, add to Home Screen first."
          : "Get a ping for new orders and listings awaiting approval.";

  return (
    <Panel className="p-4">
      <div className="flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-xl bg-muted">
          {perm === "granted" ? <Bell className="size-5 text-success" /> : <BellOff className="size-5 text-muted-foreground" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">Order &amp; approval notifications</div>
          <div className="text-[11px] text-muted-foreground">{statusLine}</div>
        </div>
        {perm === "default" && (
          <Button className="h-10 rounded-xl" disabled={busy} onClick={() => void enable()}>
            {busy ? <Loader2 className="animate-spin" /> : "Enable"}
          </Button>
        )}
        {perm === "granted" && vapidPublicKey && pushState === "unsubscribed" && (
          <Button className="h-10 rounded-xl" disabled={busy} onClick={() => void enable()}>
            {busy ? <Loader2 className="animate-spin" /> : "Subscribe"}
          </Button>
        )}
        {perm === "granted" && vapidPublicKey && pushState === "subscribed" && (
          <Button variant="secondary" className="h-10 rounded-xl" disabled={busy} onClick={() => void sendTest()}>
            {busy ? <Loader2 className="animate-spin" /> : "Send test"}
          </Button>
        )}
      </div>
      {!vapidPublicKey && (
        <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
          Background Web Push is off until the server has <code>VAPID_PUBLIC_KEY</code>, <code>VAPID_PRIVATE_KEY</code>, and{" "}
          <code>VAPID_SUBJECT</code> (a <code>mailto:</code> address). Generate a pair with <code>npm run vapid:generate</code> and add it to the
          environment. Do not commit the keys.
        </p>
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
