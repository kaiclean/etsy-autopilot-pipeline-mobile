import { AlertTriangle, CheckCircle2, ChevronRight } from "lucide-react";
import Link from "next/link";
import { Panel, SectionTitle } from "@/components/common";
import type { AttentionItem } from "@/lib/next-actions";
import { cn } from "@/lib/utils";

export function NextActions({ items }: { items: AttentionItem[] }) {
  if (items.length === 0) {
    return (
      <section>
        <SectionTitle>Needs attention</SectionTitle>
        <Panel className="flex items-start gap-3 border-success/30 bg-success/[0.06] p-4">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
          <div>
            <div className="text-sm font-semibold">Nothing needs attention</div>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              Stored job history and connection checks are clear. Publishing stays dry-run until you confirm Go live.
            </p>
          </div>
        </Panel>
      </section>
    );
  }

  const blockers = items.filter((item) => item.severity === "blocker").length;
  return (
    <section id="needs-attention">
      <SectionTitle>{blockers ? `Needs attention · ${items.length}` : `Needs attention · ${items.length}`}</SectionTitle>
      <Panel className="divide-y divide-border overflow-hidden">
        {items.map((item) => (
          <Link key={item.id} href={item.href} className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-muted/40">
            <AlertTriangle className={cn("mt-0.5 size-4 shrink-0", item.severity === "blocker" ? "text-destructive" : "text-warning")} />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold">{item.title}</div>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{item.detail}</p>
              <div className="mt-1.5 text-[11px] font-medium text-primary">{item.hrefLabel}</div>
            </div>
            <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          </Link>
        ))}
      </Panel>
    </section>
  );
}
