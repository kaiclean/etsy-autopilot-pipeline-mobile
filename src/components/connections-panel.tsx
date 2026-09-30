import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { Panel, SectionTitle } from "@/components/common";
import { healthTone, type HealthCheck } from "@/lib/health";
import { cn } from "@/lib/utils";

export function EtsyConnectCta({ canConnect }: { canConnect: boolean }) {
  return (
    <Panel className="border-warning/40 bg-warning/10 p-4">
      <div className="text-sm font-semibold">Etsy shop is not authorized</div>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        {canConnect
          ? "OAuth tokens are missing. Connect the shop so Autopilot can authorize it. Publishing stays dry-run until you confirm Go live."
          : "OAuth tokens are missing. Set ETSY_API_KEY, ETSY_SHARED_SECRET, ETSY_SHOP_ID, and ETSY_REDIRECT_URI, then connect. Publishing stays dry-run until you confirm Go live."}
      </p>
      <a
        href="/api/etsy/oauth/start"
        className="mt-3 inline-flex h-9 items-center gap-1.5 rounded-lg bg-foreground px-3 text-xs font-semibold text-background"
      >
        Connect Etsy shop <ExternalLink className="size-3.5" />
      </a>
    </Panel>
  );
}

export function ConnectionsStrip({ checks }: { checks: HealthCheck[] }) {
  return (
    <div>
      <SectionTitle
        action={
          <Link href="/connections" className="text-xs font-medium text-primary">
            Open health
          </Link>
        }
      >
        Connections
      </SectionTitle>
      <Panel className="grid grid-cols-2 gap-px overflow-hidden bg-border sm:grid-cols-4">
        {checks.map((check) => {
          const tone = healthTone(check.level);
          return (
            <Link key={check.id} href="/connections" className="bg-card px-3 py-2.5 transition-colors hover:bg-muted/40">
              <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                <span className={cn("size-1.5 rounded-full", tone.dot)} aria-hidden />
                {check.name}
              </div>
              <div className="mt-0.5 text-sm font-semibold">{check.label}</div>
            </Link>
          );
        })}
      </Panel>
    </div>
  );
}

export function ConnectionsPanel({
  checks,
  etsyConnected,
  canConnectEtsy,
}: {
  checks: HealthCheck[];
  etsyConnected: boolean;
  canConnectEtsy: boolean;
}) {
  const attention = checks.filter((c) => c.level !== "green").length;
  return (
    <section className="space-y-3">
      <SectionTitle>{attention ? `Connections · ${attention} need attention` : "Connections · all clear"}</SectionTitle>
      {!etsyConnected && <EtsyConnectCta canConnect={canConnectEtsy} />}
      <Panel className="divide-y divide-border">
        {checks.map((check) => {
          const tone = healthTone(check.level);
          return (
            <div key={check.id} className="px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2 text-sm font-medium">
                  <span className={cn("size-2 rounded-full", tone.dot)} aria-hidden />
                  {check.name}
                </span>
                <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-bold uppercase", tone.pill)}>{check.label}</span>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">{check.detail}</p>
              <p className="mt-1 font-mono text-[10px] text-muted-foreground/70">{check.envVars.join(" · ")}</p>
              {check.id === "etsy" && etsyConnected && (
                <a href="/api/etsy/oauth/start" className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-lg bg-secondary px-3 text-xs font-semibold">
                  Reconnect Etsy <ExternalLink className="size-3.5" />
                </a>
              )}
            </div>
          );
        })}
      </Panel>
      <p className="text-[11px] text-muted-foreground">
        Status uses env var names only. Secret values are never shown. Live Etsy and Printify writes stay off until you confirm Go live. The host{" "}
        <code>PUBLISH_MODE</code> variable does not turn them on by itself.
      </p>
    </section>
  );
}
