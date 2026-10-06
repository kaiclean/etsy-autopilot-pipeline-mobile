import { Panel, SectionTitle } from "@/components/common";

export function DeployPinBadge({ sha }: { sha: string | null }) {
  const short = sha ? sha.slice(0, 12) : null;
  return (
    <section id="deploy" className="scroll-mt-20 space-y-3">
      <SectionTitle>Deploy pin</SectionTitle>
      <Panel className="px-4 py-3">
        {short ? (
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-bold tracking-wide text-warning uppercase">Pinned</span>
              <span className="font-mono text-xs" data-testid="deploy-sha">
                {short}
              </span>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">Commit pinned — ask before expecting main on prod.</p>
          </div>
        ) : (
          <p className="text-xs leading-relaxed text-muted-foreground">
            No Railway commit is exposed here. <code>RAILWAY_GIT_COMMIT_SHA</code> is unset, so this environment is not showing a pin.
          </p>
        )}
      </Panel>
    </section>
  );
}
