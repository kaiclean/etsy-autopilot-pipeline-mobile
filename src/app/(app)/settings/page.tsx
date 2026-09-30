import { LogOut } from "lucide-react";
import { logout } from "@/app/actions";
import { PageHeader, SectionTitle } from "@/components/common";
import { ConnectionsPanel } from "@/components/connections-panel";
import { GoLiveControl } from "@/components/go-live-control";
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

export const metadata = { title: "Settings" };

export default async function SettingsPage({ searchParams }: PageProps<"/settings">) {
  const d = await getSettingsData();
  const sp = await searchParams;
  return (
    <div className="space-y-6">
      <EtsyStatusToast status={typeof sp.etsy === "string" ? sp.etsy : undefined} />
      <PageHeader title="Settings" subtitle={settingsModeSubtitle({ publishMode: d.publishMode, demo: d.demo })} />

      <KillSwitchCard on={d.automation.killSwitch} />

      <GoLiveControl mode={d.publishMode} envMode={d.envPublishMode} />

      <ConnectionsPanel checks={d.checks} etsyConnected={d.etsyConnected} canConnectEtsy={d.canConnectEtsy} />
      <p className="text-[11px] text-muted-foreground">
        Key setup steps and the Railway checklist are on <a className="font-medium text-primary" href="/connections#setup">Connections</a>.
      </p>

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
