import { AlertTriangle, CheckCircle2, ChevronRight, Info } from "lucide-react";
import Link from "next/link";
import { Panel, SectionTitle } from "@/components/common";
import type { AlertSeverity, CockpitAlert } from "@/lib/alerts";
import { cn } from "@/lib/utils";

function SeverityIcon({ severity }: { severity: AlertSeverity }) {
  if (severity === "info") return <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />;
  return <AlertTriangle className={cn("mt-0.5 size-4 shrink-0", severity === "blocker" ? "text-destructive" : "text-warning")} />;
}

export function AlertRail({ alerts, heading = "Alerts" }: { alerts: CockpitAlert[]; heading?: string }) {
  return (
    <section id="alerts" className="scroll-mt-20">
      <SectionTitle
        action={
          <Link href="/connections#alerts" className="text-xs font-medium text-primary">
            Connections
          </Link>
        }
      >
        {alerts.length ? `${heading} · ${alerts.length}` : heading}
      </SectionTitle>
      {alerts.length === 0 ? (
        <Panel className="flex items-start gap-3 border-success/30 bg-success/[0.06] p-4" data-testid="alert-rail-empty">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
          <div>
            <div className="text-sm font-semibold">No operational alerts</div>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              No alerts were found in the available stored data.
            </p>
          </div>
        </Panel>
      ) : (
        <Panel className="divide-y divide-border overflow-hidden" data-testid="alert-rail">
          {alerts.map((alert) => (
            <Link key={alert.id} href={alert.href} className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-muted/40" data-alert-id={alert.id}>
              <SeverityIcon severity={alert.severity} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <div className="text-sm font-semibold">{alert.title}</div>
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-muted-foreground uppercase">{alert.severity}</span>
                </div>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{alert.evidence}</p>
                <div className="mt-1.5 text-[11px] font-medium text-primary">{alert.hrefLabel}</div>
              </div>
              <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            </Link>
          ))}
        </Panel>
      )}
      <p className="mt-2 text-xs text-muted-foreground">
        Cron endpoint 401 responses are not stored as job runs. Check GitHub Actions logs and verify that CRON_SECRET matches Railway.{" "}
        <Link href="/pipeline/live" className="font-medium text-primary">
          Pipeline live log
        </Link>
      </p>
    </section>
  );
}
