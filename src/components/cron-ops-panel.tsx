import Link from "next/link";
import { CopyButton } from "@/components/copy-button";
import { Panel, SectionTitle, STAGE_ICONS } from "@/components/common";
import { describeCron } from "@/lib/cron";
import { relTime } from "@/lib/format";
import { externalCronExample } from "@/lib/ops-copy";
import type { StageSnapshot } from "@/lib/next-actions";
import { cn } from "@/lib/utils";

export function CronOpsPanel({ stages, origin }: { stages: StageSnapshot[]; origin: string | undefined }) {
  const example = externalCronExample(origin);
  return (
    <section id="cron" className="scroll-mt-20 space-y-3">
      <SectionTitle action={<CopyButton text={example} label="Copy cron example" />}>Automation cron</SectionTitle>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Railway does not run these schedules. <code>.github/workflows/autopilot-cron.yml</code> calls{" "}
        <code>GET /api/cron/&lt;stage&gt;</code> on the default branch. After that workflow is merged, add GitHub repository secrets{" "}
        <code>CRON_SECRET</code> (the same value as Railway) and optional <code>AUTOPILOT_URL</code>. If <code>AUTOPILOT_URL</code> is empty, the
        workflow uses the production Railway URL. The workflow file and this page never contain the secret. The curl example keeps the{" "}
        <code>$CRON_SECRET</code> placeholder. Schedules do not turn on live publishing. Pause a stage from{" "}
        <Link href="/settings" className="font-medium text-primary">
          Settings
        </Link>
        .
      </p>
      <Panel className="divide-y divide-border">
        {stages.map((stage) => {
          const Icon = STAGE_ICONS[stage.id];
          return (
            <div key={stage.id} className="flex items-start gap-3 px-4 py-3">
              <Icon className="mt-0.5 size-4 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-medium">{stage.label}</div>
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[10px] font-bold uppercase",
                      stage.paused ? "bg-warning/15 text-warning" : "bg-success/15 text-success",
                    )}
                  >
                    {stage.paused ? "Paused" : "Scheduled"}
                  </span>
                </div>
                <div className="font-mono text-[11px] text-muted-foreground">
                  {describeCron(stage.cron)} · {stage.cron}
                </div>
                <div className="text-[11px] text-muted-foreground" suppressHydrationWarning>
                  {stage.lastStartedAt
                    ? `Last ${stage.lastStatus} · ${relTime(stage.lastStartedAt)}`
                    : "Never run"}
                </div>
              </div>
            </div>
          );
        })}
      </Panel>
      <pre className="overflow-x-auto rounded-2xl border border-border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">{example}</pre>
    </section>
  );
}
