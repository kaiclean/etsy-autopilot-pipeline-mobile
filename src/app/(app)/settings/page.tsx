import { ExternalLink, LogOut } from "lucide-react";
import { logout } from "@/app/actions";
import { PageHeader, Panel, SectionTitle } from "@/components/common";
import {
  BudgetsForm,
  EtsyStatusToast,
  KillSwitchCard,
  NotificationsCard,
  SchedulesList,
  ThemeToggle,
} from "@/components/settings/settings-client";
import { config, vapidConfigured } from "@/lib/config";
import { settingsModeSubtitle } from "@/lib/operator-mode";
import { getSettingsData } from "@/lib/queries";
import { cn } from "@/lib/utils";

export const metadata = { title: "Settings" };

const STATUS_STYLE = {
  connected: { label: "Connected", cls: "bg-success/15 text-success" },
  configured: { label: "Configured", cls: "bg-chart-4/15 text-chart-4" },
  mock: { label: "Mock", cls: "bg-warning/15 text-warning" },
  missing: { label: "Action needed", cls: "bg-destructive/15 text-destructive" },
};

export default async function SettingsPage({ searchParams }: PageProps<"/settings">) {
  const d = await getSettingsData();
  const sp = await searchParams;
  return (
    <div className="space-y-6">
      <EtsyStatusToast status={typeof sp.etsy === "string" ? sp.etsy : undefined} />
      <PageHeader
        title="Settings"
        subtitle={settingsModeSubtitle({ publishMode: d.publishMode, demo: d.demo })}
      />

      <KillSwitchCard on={d.automation.killSwitch} />

      <section>
        <SectionTitle>Integrations</SectionTitle>
        <Panel className="divide-y divide-border">
          {d.integrations.map((i) => (
            <div key={i.id} className="px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium">{i.name}</span>
                <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-bold uppercase", STATUS_STYLE[i.status].cls)}>{STATUS_STYLE[i.status].label}</span>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">{i.detail}</p>
              <p className="mt-1 font-mono text-[10px] text-muted-foreground/70">{i.envVars.join(" · ")}</p>
              {i.id === "etsy" && d.canConnectEtsy && (
                <a href="/api/etsy/oauth/start" className="mt-2 inline-flex h-9 items-center gap-1.5 rounded-lg bg-secondary px-3 text-xs font-semibold">
                  {d.etsyConnected ? "Reconnect Etsy" : "Connect Etsy shop"} <ExternalLink className="size-3.5" />
                </a>
              )}
            </div>
          ))}
        </Panel>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Secrets are read from environment variables only and are never stored or shown here. Publishing goes live only when{" "}
          <code>PUBLISH_MODE=live</code> and credentials are present.
        </p>
      </section>

      <section>
        <SectionTitle>Budgets &amp; caps</SectionTitle>
        <BudgetsForm automation={d.automation} />
      </section>

      <section>
        <SectionTitle>Schedules</SectionTitle>
        <SchedulesList stages={d.stages} />
        <p className="mt-2 text-[11px] text-muted-foreground">Times are defined in vercel.json (UTC). Toggles pause the scheduled run; manual runs still work.</p>
      </section>

      <section className="space-y-3">
        <SectionTitle>App</SectionTitle>
        <NotificationsCard vapidPublicKey={vapidConfigured() ? (config.vapid.publicKey ?? null) : null} />
        <ThemeToggle />
        <form action={logout}>
          <button className="flex w-full items-center justify-center gap-2 rounded-2xl border border-border py-3.5 text-sm font-medium text-muted-foreground active:bg-muted/50">
            <LogOut className="size-4" /> Sign out
          </button>
        </form>
      </section>
    </div>
  );
}
