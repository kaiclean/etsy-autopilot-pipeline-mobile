import { Power } from "lucide-react";
import Link from "next/link";
import { NicheTag, PageHeader, Panel, SectionTitle } from "@/components/common";
import { StageCard } from "@/components/pipeline/stage-card";
import { RunPipelineButton } from "@/components/run-button";
import { getPipelineData } from "@/lib/queries";

export const metadata = { title: "Pipeline" };

export default async function PipelinePage() {
  const { stages, automation, keywords } = await getPipelineData();
  return (
    <div className="space-y-6">
      <PageHeader
        title="Pipeline"
        subtitle="Stages run on schedule or on demand. The approval queue sits between Listing and Publish."
        action={<RunPipelineButton compact disabled={automation.killSwitch} />}
      />

      {automation.killSwitch && (
        <Link href="/settings">
          <Panel className="flex items-center gap-3 border-destructive/40 bg-destructive/10 p-4">
            <Power className="size-5 text-destructive" />
            <div className="flex-1">
              <div className="font-semibold text-destructive">Kill switch is on</div>
              <div className="text-xs text-muted-foreground">All scheduled and manual runs are blocked. Turn it off in Settings.</div>
            </div>
          </Panel>
        </Link>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {stages.map((s) => (
          <StageCard key={s.id} id={s.id} label={s.label} description={s.description} settings={s.settings} runs={s.runs} killSwitch={automation.killSwitch} />
        ))}
      </div>

      <div>
        <SectionTitle>Keyword backlog · top scored</SectionTitle>
        <Panel className="divide-y divide-border">
          {keywords.length === 0 && <p className="p-6 text-center text-sm text-muted-foreground">Backlog empty. Run Research to collect new candidates.</p>}
          {keywords.map((k) => (
            <div key={k.id} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{k.phrase}</div>
                <div className="mt-1 flex items-center gap-2">
                  <NicheTag niche={k.niche} />
                  <span className="text-[11px] text-muted-foreground">
                    {k.source}
                    {k.status === "selected" ? " · selected for design" : ""}
                  </span>
                </div>
              </div>
              <div className="w-20 text-right">
                <div className="tabular text-sm font-semibold">{Math.round(k.score * 100)}</div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${Math.round(k.score * 100)}%` }} />
                </div>
              </div>
            </div>
          ))}
        </Panel>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Score = 45% demand (seed signal + Google Trends when reachable) + 30% low competition + 25% seasonality.
        </p>
      </div>
    </div>
  );
}
