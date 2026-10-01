import { ChevronRight, Inbox } from "lucide-react";
import Link from "next/link";
import { ActivityFeed } from "@/components/activity-feed";
import { ConnectionsStrip, EtsyConnectCta } from "@/components/connections-panel";
import { Panel, SectionTitle, STAGE_ICONS, Thumb } from "@/components/common";
import { HeroKpis } from "@/components/home/hero-kpis";
import { NextActions } from "@/components/home/next-actions";
import { RunPipelineButton } from "@/components/run-button";
import { chf, relTime, TZ } from "@/lib/format";
import { buildNextActions, toStageSnapshots } from "@/lib/next-actions";
import { getConnectionsData, getHomeData } from "@/lib/queries";
import { cn } from "@/lib/utils";

function greeting() {
  const h = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: TZ }).format(new Date()));
  return h < 5 ? "Late night, Kai" : h < 12 ? "Good morning, Kai" : h < 18 ? "Good afternoon, Kai" : "Good evening, Kai";
}

export default async function HomePage() {
  const [data, connections] = await Promise.all([getHomeData(), getConnectionsData()]);
  const today = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: TZ });
  const failing = data.lastRuns.filter((s) => s.run?.status === "failed").length;
  const attention = buildNextActions({
    etsyConnected: connections.etsyConnected,
    etsyKeysReady: connections.etsyKeysReady,
    printifyConfigured: connections.printifyConfigured,
    webhookSecretSet: connections.webhookSecretSet,
    printifyEventCount: connections.printifyEventCount,
    killSwitch: data.killSwitch,
    publishMode: connections.publishMode,
    hostPublishMode: connections.envPublishMode,
    stages: toStageSnapshots(connections.lastRuns, connections.stages),
    checks: connections.checks,
  });

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">{today}</p>
          <h1 className="text-[26px] leading-tight font-semibold tracking-tight md:text-3xl">{greeting()}</h1>
        </div>
        <RunPipelineButton className="hidden md:inline-flex" disabled={data.killSwitch} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-6">
          <NextActions items={attention} />
          <ConnectionsStrip checks={connections.checks} />
          {!connections.etsyConnected && <EtsyConnectCta canConnect={connections.canConnectEtsy} />}
          <HeroKpis kpis={data.kpis} series={data.series} />

          {data.pending.length > 0 && (
            <Link href="/queue" className="block">
              <Panel className="flex items-center gap-3.5 border-warning/30 bg-warning/[0.06] p-4 transition-transform active:scale-[0.99]">
                <div className="flex shrink-0 -space-x-4">
                  {data.pending.slice(0, 3).map((p) => (
                    <Thumb key={p.id} src={p.imageUrl} alt="" className="size-11 border-2 border-card" />
                  ))}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">
                    {data.pendingCount} listing{data.pendingCount === 1 ? "" : "s"} to review
                  </div>
                  <div className="text-xs text-muted-foreground">Nothing goes live without your approval</div>
                </div>
                <span className="hidden shrink-0 items-center gap-1 rounded-full bg-warning px-3 py-1.5 text-xs font-bold text-black sm:flex">
                  <Inbox className="size-3.5" /> Review
                </span>
                <ChevronRight className="size-5 shrink-0 text-warning sm:hidden" />
              </Panel>
            </Link>
          )}

          <div>
            <SectionTitle
              action={
                <Link href="/pipeline" className="flex items-center text-xs font-medium text-primary">
                  Pipeline <ChevronRight className="size-3.5" />
                </Link>
              }
            >
              Pipeline health {failing ? <span className="ml-1 text-destructive normal-case">· {failing} failing</span> : null}
            </SectionTitle>
            <div className="no-scrollbar -mx-4 flex snap-x gap-2.5 overflow-x-auto px-4 md:mx-0 md:grid md:grid-cols-3 md:px-0 xl:grid-cols-6">
              {data.lastRuns.map((s) => {
                const Icon = STAGE_ICONS[s.id];
                const st = s.run?.status;
                return (
                  <Link key={s.id} href="/pipeline" className="snap-start">
                    <Panel className="w-[138px] p-3 md:w-auto">
                      <div className="flex items-center justify-between">
                        <Icon className="size-4 text-muted-foreground" />
                        <span
                          className={cn(
                            "size-2 rounded-full",
                            st === "success" ? "bg-success" : st === "failed" ? "bg-destructive" : st === "running" ? "animate-pulse bg-chart-4" : st === "skipped" ? "bg-warning" : "bg-muted-foreground/40",
                          )}
                        />
                      </div>
                      <div className="mt-2 text-sm font-semibold">{s.label}</div>
                      <div className="text-[11px] text-muted-foreground" suppressHydrationWarning>
                        {s.run ? relTime(s.run.startedAt) : "Never run"}
                      </div>
                    </Panel>
                  </Link>
                );
              })}
            </div>
          </div>

          <RunPipelineButton className="w-full md:hidden" disabled={data.killSwitch} />
        </div>

        <div>
          <SectionTitle action={<span className="text-[11px] text-muted-foreground">{data.liveListings} published · {chf(data.kpis["30d"].cur.profit, { compact: true })} 30d</span>}>
            Live activity
          </SectionTitle>
          <Panel className="overflow-hidden">
            <ActivityFeed events={data.feed} />
          </Panel>
        </div>
      </div>
    </div>
  );
}
