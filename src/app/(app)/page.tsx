import { Activity, ArrowUpRight, ChevronRight, Inbox, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { ActivityFeed } from "@/components/activity-feed";
import { ConnectionsStrip, EtsyConnectCta } from "@/components/connections-panel";
import { Panel, SectionTitle, STAGE_ICONS, Thumb } from "@/components/common";
import { HeroKpis } from "@/components/home/hero-kpis";
import { NextActions } from "@/components/home/next-actions";
import { OpsCards } from "@/components/home/ops-cards";
import { RunPipelineButton } from "@/components/run-button";
import { chf, relTime, TZ } from "@/lib/format";
import { buildNextActions, toStageSnapshots } from "@/lib/next-actions";
import { AlertRail } from "@/components/alert-rail";
import { getCockpitAlerts, getConnectionsData, getDashboardOps, getHomeData } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { formatMaintenanceSummary } from "@/lib/maintenance-summary";

function greeting() {
  const h = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: TZ }).format(new Date()));
  return h < 5 ? "Late night, Kai" : h < 12 ? "Good morning, Kai" : h < 18 ? "Good afternoon, Kai" : "Good evening, Kai";
}

export default async function HomePage() {
  const [data, connections, alerts, ops] = await Promise.all([
    getHomeData(),
    getConnectionsData(),
    getCockpitAlerts(),
    getDashboardOps(),
  ]);
  const today = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: TZ });
  const failing = data.lastRuns.filter((s) => s.run?.status === "failed").length;
  const warning = data.lastRuns.filter((s) => s.run?.status === "warning").length;
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
  const systemNeedsAttention = failing > 0 || warning > 0 || attention.length > 0 || data.killSwitch;

  return (
    <div className="space-y-6">
      <div className="relative overflow-hidden rounded-3xl border border-primary/15 bg-gradient-to-br from-card via-card to-primary/[0.09] p-4 shadow-sm md:p-6">
        <div className="pointer-events-none absolute -top-28 right-10 size-72 rounded-full bg-primary/[0.09] blur-3xl" />
        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/20 bg-primary/10 px-2.5 py-1 text-[10px] font-bold tracking-[0.12em] text-primary uppercase">
                <Activity className="size-3" /> Shop command center
              </span>
              <span className="text-xs text-muted-foreground">{today}</span>
            </div>
            <h1 className="text-[26px] leading-tight font-semibold tracking-tight md:text-3xl">{greeting()}</h1>
            <p className="mt-1 max-w-xl text-sm text-muted-foreground">
              {systemNeedsAttention
                ? "A few items need your attention. Review the shop pulse before the next run."
                : "Your shop is on track. Review performance and keep the pipeline moving."}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span
              role="status"
              className={`inline-flex h-9 items-center gap-2 rounded-full border px-3 text-xs font-semibold ${
                systemNeedsAttention
                  ? "border-warning/30 bg-warning/10 text-warning"
                  : "border-success/30 bg-success/10 text-success"
              }`}
            >
              {systemNeedsAttention ? <Inbox className="size-3.5" /> : <ShieldCheck className="size-3.5" />}
              {systemNeedsAttention ? "Needs a look" : "System healthy"}
            </span>
            <RunPipelineButton className="hidden md:inline-flex" disabled={data.killSwitch} />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-6">
          <NextActions items={attention} />
          <AlertRail alerts={alerts} />
          <ConnectionsStrip checks={connections.checks} />
          {!connections.etsyConnected && <EtsyConnectCta canConnect={connections.canConnectEtsy} />}
          <HeroKpis kpis={data.kpis} series={data.series} />
          <OpsCards failures={ops.failures} failureCount={ops.failureCount} needsFixes={ops.needsFixes} report={ops.report} stalled={ops.stalled} />

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
            <div className="no-scrollbar -mx-4 flex snap-x gap-2.5 overflow-x-auto px-4 md:mx-0 md:grid md:grid-cols-3 md:px-0 lg:grid-cols-4 2xl:grid-cols-5">
              {data.lastRuns.map((s) => {
                const Icon = STAGE_ICONS[s.id];
                const st = s.run?.status;
                const summary = s.id === "maintenance" ? formatMaintenanceSummary(s.run?.summary) : s.run?.summary;
                const statusLabel =
                  st === "success" ? "Succeeded" : st === "warning" ? "Warning" : st === "failed" ? "Failed" : st === "running" ? "Running" : st === "skipped" ? "Skipped" : "Not run";
                const duration =
                  s.run?.finishedAt && s.run.startedAt
                    ? Math.max(0, Math.round((new Date(s.run.finishedAt).getTime() - new Date(s.run.startedAt).getTime()) / 1000))
                    : null;
                const durationLabel = duration == null ? null : duration < 60 ? `${duration}s` : `${Math.floor(duration / 60)}m ${duration % 60}s`;
                return (
                  <Link
                    key={s.id}
                    href="/pipeline"
                    className="snap-start"
                    aria-label={`${s.label}: ${statusLabel}${summary ? `, ${summary}` : ""}`}
                  >
                    <Panel className="group w-[158px] overflow-hidden p-3 transition-colors hover:border-primary/30 hover:bg-muted/20 md:w-auto">
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex size-8 items-center justify-center rounded-xl bg-muted/70 transition-colors group-hover:bg-primary/10">
                          <Icon className="size-4 text-muted-foreground group-hover:text-primary" />
                        </span>
                        <span className="flex items-center gap-1.5">
                          <span
                            className={cn(
                              "size-2 rounded-full",
                              st === "success" ? "bg-success" : st === "failed" ? "bg-destructive" : st === "warning" ? "bg-warning" : st === "running" ? "animate-pulse bg-chart-4" : st === "skipped" ? "bg-warning" : "bg-muted-foreground/40",
                            )}
                          />
                          <span className="text-[10px] font-semibold text-muted-foreground">{statusLabel}</span>
                        </span>
                      </div>
                      <div className="mt-2 flex items-center justify-between gap-2">
                        <div className="truncate text-sm font-semibold">{s.label}</div>
                        <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                      </div>
                      <div className="mt-1 min-h-8 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                        {summary || "No run recorded yet"}
                      </div>
                      <div className="mt-2 flex items-center justify-between border-t border-border/70 pt-2 text-[10px] text-muted-foreground">
                        <span suppressHydrationWarning>{s.run ? relTime(s.run.startedAt) : "Never run"}</span>
                        {durationLabel && <span className="tabular">{durationLabel}</span>}
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
