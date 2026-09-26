"use client";

import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { AppEvent } from "@/db/schema";
import { relTime } from "@/lib/format";
import { cn } from "@/lib/utils";

const ICON = {
  success: { Icon: CheckCircle2, cls: "text-success bg-success/10" },
  info: { Icon: Info, cls: "text-chart-4 bg-chart-4/10" },
  warning: { Icon: AlertTriangle, cls: "text-warning bg-warning/10" },
  error: { Icon: XCircle, cls: "text-destructive bg-destructive/10" },
};

export function ActivityFeed({ events, limit = 12 }: { events: AppEvent[]; limit?: number }) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  if (events.length === 0) {
    return <p className="px-4 py-8 text-center text-sm text-muted-foreground">No activity yet. Run the pipeline to get started.</p>;
  }
  return (
    <ul className="divide-y divide-border">
      {events.slice(0, limit).map((e) => {
        const { Icon, cls } = ICON[e.severity];
        const body = (
          <div className="flex gap-3 px-4 py-3">
            <span className={cn("mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full", cls)}>
              <Icon className="size-3.5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-sm font-medium">{e.title}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground" suppressHydrationWarning>
                  {relTime(e.createdAt)}
                </span>
              </div>
              {e.body && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{e.body}</p>}
            </div>
          </div>
        );
        return (
          <li key={e.id} className="animate-in fade-in slide-in-from-top-1 duration-300">
            {e.href ? (
              <Link href={e.href} className="block transition-colors active:bg-muted/50 md:hover:bg-muted/40">
                {body}
              </Link>
            ) : (
              body
            )}
          </li>
        );
      })}
    </ul>
  );
}
