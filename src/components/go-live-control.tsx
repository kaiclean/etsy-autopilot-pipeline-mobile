"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { setPublishMode } from "@/app/actions";
import { Panel } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { GO_LIVE_ACK, GO_LIVE_CONFIRMATION, type PublishMode } from "@/lib/publish-mode";

export function GoLiveControl({ mode, envMode }: { mode: PublishMode; envMode: PublishMode }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [pending, start] = useTransition();
  const ready = understood && confirmation === GO_LIVE_CONFIRMATION;

  const apply = (next: PublishMode) =>
    start(async () => {
      const result = await setPublishMode(next, confirmation, understood);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(next === "live" ? "Live writes armed" : "Back to dry-run");
      setOpen(false);
      setUnderstood(false);
      setConfirmation("");
      router.refresh();
    });

  if (mode === "live") {
    return (
      <Panel className="space-y-3 border-destructive/40 bg-destructive/10 p-4">
        <div>
          <div className="font-semibold">Live writes are on</div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            The dashboard choice is live. Approved listings can be sent to Etsy and Printify on the next publish run. Host <code>PUBLISH_MODE</code> is{" "}
            {envMode}. That variable does not arm writes by itself, and new Etsy listings stay drafts unless you also set <code>ETSY_ACTIVATE=true</code>.
          </p>
        </div>
        <Button variant="secondary" className="h-10 rounded-xl" disabled={pending} onClick={() => apply("dry-run")}>
          {pending ? <Loader2 className="animate-spin" /> : "Return to dry-run"}
        </Button>
      </Panel>
    );
  }

  return (
    <Panel className="space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold">Dry-run</div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Default. Nothing is sent to Etsy or Printify. Host <code>PUBLISH_MODE</code> is {envMode}. Leave it at dry-run on Railway. The switch below is
            what this app uses, and it stays off until you confirm.
          </p>
        </div>
        {!open && (
          <Button className="h-10 rounded-xl" onClick={() => setOpen(true)}>
            Go live
          </Button>
        )}
      </div>
      {open && (
        <div className="space-y-3 border-t border-border pt-3">
          <label className="flex items-start gap-2.5 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-current"
              checked={understood}
              onChange={(e) => setUnderstood(e.target.checked)}
            />
            <span>{GO_LIVE_ACK}</span>
          </label>
          <label className="block text-xs text-muted-foreground">
            Type {GO_LIVE_CONFIRMATION} to arm live publishing
            <Input
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="mt-1.5 h-10 rounded-xl font-mono"
              placeholder={GO_LIVE_CONFIRMATION}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button variant="destructive" className="h-10 rounded-xl" disabled={!ready || pending} onClick={() => apply("live")}>
              {pending ? <Loader2 className="animate-spin" /> : "Arm live publishing"}
            </Button>
            <Button
              variant="secondary"
              className="h-10 rounded-xl"
              disabled={pending}
              onClick={() => {
                setOpen(false);
                setUnderstood(false);
                setConfirmation("");
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Panel>
  );
}
