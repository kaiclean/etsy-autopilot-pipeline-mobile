"use client";

import { useEffect, useState } from "react";
import { Panel } from "@/components/common";
import type { PipelineLive } from "@/lib/pipeline-live";
import { cn } from "@/lib/utils";

function formatDuration(ms: number | null) {
  if (ms == null) return "running";
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 100) / 10;
  return `${seconds}s`;
}

function formatTime(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function LiveLog({ initial }: { initial: PipelineLive }) {
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [data, setData] = useState(initial);
  const [updated, setUpdated] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    const pull = async () => {
      const res = await fetch(`/api/pipeline/live${errorsOnly ? "?errors=1" : ""}`, { cache: "no-store" });
      if (!res.ok || stop) return;
      setData((await res.json()) as PipelineLive);
      setUpdated(new Date().toLocaleTimeString());
    };
    const timer = setInterval(pull, 4000);
    void pull();
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [errorsOnly]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={errorsOnly} onChange={(event) => setErrorsOnly(event.target.checked)} />
          Errors only
        </label>
        <span className="text-xs text-muted-foreground">{updated ? `Updated ${updated}` : "Polling every 4s"}</span>
      </div>

      <section>
        <h2 className="mb-2 text-sm font-semibold">Last {data.runs.length} runs</h2>
        <Panel className="divide-y divide-border overflow-hidden">
          {data.runs.length === 0 && <p className="p-4 text-sm text-muted-foreground">No pipeline runs yet.</p>}
          {data.runs.map((run) => (
            <div key={run.id} className="grid gap-1 px-4 py-3 sm:grid-cols-[8rem_6rem_1fr_5rem]">
              <div className="text-sm font-medium">{run.stage}</div>
              <div className={cn("text-xs font-semibold uppercase", run.status === "failed" ? "text-destructive" : run.status === "success" ? "text-success" : "text-muted-foreground")}>
                {run.status}
              </div>
              <div className="min-w-0 text-xs text-muted-foreground">
                <div className="truncate">{run.summary || "No summary"}</div>
                <div>
                  {formatTime(run.startedAt)} · {run.trigger}
                  {run.errorCount ? ` · ${run.errorCount} error${run.errorCount === 1 ? "" : "s"}` : ""}
                </div>
              </div>
              <div className="text-xs tabular-nums text-muted-foreground sm:text-right">{formatDuration(run.durationMs)}</div>
            </div>
          ))}
        </Panel>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold">Stage log</h2>
        <Panel className="max-h-[28rem] overflow-auto font-mono text-[12px] leading-relaxed">
          {data.lines.length === 0 && <p className="p-4 font-sans text-sm text-muted-foreground">No log lines in this view.</p>}
          {data.lines.map((line, index) => (
            <div key={`${line.runId}-${line.t}-${index}`} className={cn("border-b border-border/60 px-3 py-1.5", line.level === "error" && "bg-destructive/10 text-destructive")}>
              <span className="text-muted-foreground">{formatTime(line.t)}</span>{" "}
              <span className="uppercase">{line.level}</span> <span>[{line.stage}]</span> {line.message}
            </div>
          ))}
        </Panel>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold">Publish errors</h2>
        <Panel className="divide-y divide-border">
          {data.publishErrors.length === 0 && <p className="p-4 text-sm text-muted-foreground">No publishError text on current listings.</p>}
          {data.publishErrors.map((row) => (
            <div key={row.id} className="px-4 py-3">
              <div className="text-sm font-medium">{row.title}</div>
              <div className="mt-1 text-xs text-destructive">{row.publishError}</div>
              <div className="mt-1 text-[11px] text-muted-foreground">{formatTime(row.updatedAt)}</div>
            </div>
          ))}
        </Panel>
      </section>
    </div>
  );
}
