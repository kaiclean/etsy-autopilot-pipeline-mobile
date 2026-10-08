"use client";

import { Loader2, Play, Zap } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { triggerFullPipeline, triggerStage } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function RunStageButton({ stage, label, disabled, className }: { stage: string; label?: string; disabled?: boolean; className?: string }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <Button
      size="lg"
      variant="secondary"
      disabled={pending || disabled}
      className={cn("h-10 rounded-xl px-3.5", className)}
      onClick={() =>
        start(async () => {
          const r = await triggerStage(stage);
          router.refresh();
          if (r.status === "skipped") toast.warning(`Skipped: ${r.summary}`);
          else if (r.status === "warning") toast.warning(r.summary ?? "Finished with warnings");
          else if (!r.ok) toast.error(r.summary ?? r.error ?? "Run failed");
          else if (r.summary) toast.success(r.summary);
        })
      }
    >
      {pending ? <Loader2 className="animate-spin" /> : <Play className="size-4" />}
      {label ?? "Run"}
    </Button>
  );
}

export function RunPipelineButton({ disabled, className, compact }: { disabled?: boolean; className?: string; compact?: boolean }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <Button
      size="lg"
      disabled={pending || disabled}
      className={cn("h-11 rounded-xl px-4 font-semibold", className)}
      onClick={() =>
        start(async () => {
          const id = toast.loading("Running research → design → listing → publish → orders → analytics…");
          const runs = await triggerFullPipeline();
          router.refresh();
          const failed = runs.filter((r) => r.status === "failed");
          const warned = runs.filter((r) => r.status === "warning");
          const skipped = runs.find((r) => r.status === "skipped");
          toast.dismiss(id);
          if (skipped?.summary?.startsWith("Kill switch")) toast.error("Kill switch is on. Nothing ran.");
          else if (failed.length) toast.error(`${failed.length} stage(s) failed`, { description: failed.map((f) => `${f.stage}: ${f.summary}`).join("\n") });
          else if (warned.length) toast.warning(`${warned.length} stage(s) finished with warnings`, { description: warned.map((f) => `${f.stage}: ${f.summary}`).join("\n") });
          else toast.success("Pipeline finished", { description: runs.map((r) => `${r.stage}: ${r.summary}`).join("\n") });
        })
      }
    >
      {pending ? <Loader2 className="animate-spin" /> : <Zap className="size-4" />}
      {compact ? "Run all" : "Run full pipeline"}
    </Button>
  );
}
