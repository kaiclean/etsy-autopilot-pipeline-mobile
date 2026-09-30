"use client";

import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Panel, SectionTitle } from "@/components/common";
import { Button } from "@/components/ui/button";
import { setupChecklist, stepStatus, SETUP_STEPS, type SetupStepStatus } from "@/lib/setup-guide";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<SetupStepStatus, string> = {
  ready: "Connected",
  partial: "Incomplete",
  missing: "Missing",
};

const STATUS_PILL: Record<SetupStepStatus, string> = {
  ready: "bg-success/15 text-success",
  partial: "bg-warning/15 text-warning",
  missing: "bg-destructive/15 text-destructive",
};

export function SetupGuide({
  presence,
  etsyConnected,
  canConnectEtsy,
  redirectUri,
}: {
  presence: Record<string, boolean>;
  etsyConnected: boolean;
  canConnectEtsy: boolean;
  redirectUri: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(setupChecklist());
      setCopied(true);
      toast.success("Checklist copied. Paste it into Railway variables or .env.local.");
    } catch {
      toast.error("Could not copy. Select the checklist instead.");
    }
  };

  return (
    <section id="setup" className="scroll-mt-20 space-y-3">
      <SectionTitle
        action={
          <Button variant="secondary" className="h-8 rounded-lg px-3 text-xs" onClick={copy}>
            {copied ? "Copied" : "Copy checklist"}
          </Button>
        }
      >
        Setup guide
      </SectionTitle>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Add each value in the host environment (Railway → Variables, or <code>.env.local</code> locally). This page shows names and whether they are set.
        It never shows secret values. After Etsy keys are in place, connect the shop. Publishing stays dry-run until you confirm Go live.
      </p>
      <div className="space-y-3">
        {SETUP_STEPS.map((step, index) => {
          const status = stepStatus(step, presence, etsyConnected);
          return (
            <Panel key={step.id} className="space-y-2 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="text-sm font-semibold">
                  {index + 1}. {step.title}
                </div>
                <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-bold uppercase", STATUS_PILL[status])}>{STATUS_LABEL[status]}</span>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">{step.summary}</p>
              <ul className="list-disc space-y-1 pl-4 text-xs leading-relaxed text-muted-foreground">
                {step.bullets.map((bullet) => (
                  <li key={bullet}>{bullet}</li>
                ))}
              </ul>
              <div className="flex flex-wrap gap-1.5">
                {[...step.envVars, ...step.optionalEnvVars].map((name) => (
                  <span
                    key={name}
                    className={cn(
                      "rounded-md px-1.5 py-0.5 font-mono text-[10px]",
                      presence[name] ? "bg-success/15 text-success" : "bg-muted text-muted-foreground",
                    )}
                  >
                    {name}
                    {step.optionalEnvVars.includes(name) ? " · optional" : ""}
                    {presence[name] ? " · set" : " · missing"}
                  </span>
                ))}
              </div>
              <a href={step.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-primary">
                {step.hrefLabel} <ExternalLink className="size-3" />
              </a>
              {step.id === "etsy" && (
                <div className="rounded-xl bg-muted/50 p-3 text-xs">
                  <div className="font-medium">Redirect URI to register</div>
                  <code className="mt-1 block font-mono text-[11px] break-all">{redirectUri}</code>
                  <p className="mt-1 text-muted-foreground">
                    {etsyConnected ? "OAuth tokens are stored." : "OAuth tokens are missing."} Set <code>ETSY_REDIRECT_URI</code> to that value, then connect.
                  </p>
                  <a href="/api/etsy/oauth/start" className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-lg bg-foreground px-3 text-xs font-semibold text-background">
                    {etsyConnected ? "Reconnect Etsy shop" : "Connect Etsy shop"} <ExternalLink className="size-3.5" />
                  </a>
                  {!canConnectEtsy && !etsyConnected && <p className="mt-1 text-muted-foreground">The connect link asks for ETSY_API_KEY before it can start.</p>}
                </div>
              )}
            </Panel>
          );
        })}
      </div>
      <Panel className="space-y-2 p-4">
        <div className="text-sm font-semibold">Railway checklist</div>
        <p className="text-xs text-muted-foreground">
          Copy these names into Railway variables. <code>PUBLISH_MODE</code> stays <code>dry-run</code>. Live writes turn on only from the Go live control after you
          type CONFIRM.
        </p>
        <pre className="overflow-x-auto rounded-xl bg-muted/60 p-3 font-mono text-[11px] leading-relaxed">{setupChecklist()}</pre>
      </Panel>
    </section>
  );
}
