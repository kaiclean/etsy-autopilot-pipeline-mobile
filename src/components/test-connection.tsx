"use client";

import { Loader2, PlugZap } from "lucide-react";
import { useState, useTransition } from "react";
import { testProviderConnections } from "@/app/actions";
import { Button } from "@/components/ui/button";
import type { ProbeResult, ProbeStatus } from "@/lib/provider-probe";
import { cn } from "@/lib/utils";

const TONE: Record<ProbeStatus, string> = {
  ok: "bg-success/15 text-success",
  "401": "bg-destructive/15 text-destructive",
  "402": "bg-warning/15 text-warning",
  "404": "bg-destructive/15 text-destructive",
  "model not found": "bg-destructive/15 text-destructive",
  skipped: "bg-muted text-muted-foreground",
  error: "bg-destructive/15 text-destructive",
};

function ProbeLine({ label, probe }: { label: string; probe: ProbeResult }) {
  return (
    <div className="flex items-start justify-between gap-3 text-xs">
      <div>
        <div className="font-medium">{label}</div>
        <p className="text-muted-foreground">{probe.detail}</p>
      </div>
      <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase", TONE[probe.status])}>{probe.status}</span>
    </div>
  );
}

export function TestConnectionButton() {
  const [pending, start] = useTransition();
  const [probes, setProbes] = useState<{ text: ProbeResult; image: ProbeResult } | null>(null);
  const [failed, setFailed] = useState(false);

  return (
    <div className="space-y-2 rounded-2xl border border-border px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium">Test connection</div>
          <p className="text-xs text-muted-foreground">One tiny text request, plus a cheap image request when images are configured.</p>
        </div>
        <Button
          type="button"
          variant="secondary"
          className="h-9 rounded-lg px-3 text-xs"
          disabled={pending}
          onClick={() =>
            start(async () => {
              setFailed(false);
              try {
                const next = await testProviderConnections();
                setProbes(next);
              } catch {
                setFailed(true);
                setProbes(null);
              }
            })
          }
        >
          {pending ? <Loader2 className="animate-spin" /> : <PlugZap className="size-3.5" />}
          Test connection
        </Button>
      </div>
      {failed && <p className="text-xs text-destructive">The test could not run. Sign in again and retry.</p>}
      {probes && (
        <div className="space-y-2 border-t border-border pt-2">
          <ProbeLine label="Text" probe={probes.text} />
          <ProbeLine label="Images" probe={probes.image} />
        </div>
      )}
    </div>
  );
}
