import Link from "next/link";
import { getDb } from "@/db";
import { PageHeader, Panel } from "@/components/common";
import { requireAuth } from "@/lib/session";
import { runDeepHealth, type ProbeStatus } from "@/lib/deep-health";

export const metadata = { title: "Status" };
export const dynamic = "force-dynamic";

const TONE: Record<ProbeStatus, { dot: string; label: string }> = {
  ok: { dot: "bg-success", label: "OK" },
  warn: { dot: "bg-warning", label: "Attention" },
  fail: { dot: "bg-destructive", label: "Failing" },
  skipped: { dot: "bg-muted-foreground/40", label: "Not configured" },
};

export default async function StatusPage({ searchParams }: { searchParams: Promise<{ fresh?: string }> }) {
  await requireAuth();
  const sp = await searchParams;
  const h = await runDeepHealth(await getDb(), { fresh: sp.fresh === "1" });
  const at = new Date(h.at).toLocaleString("de-CH", { timeZone: "Europe/Zurich", dateStyle: "short", timeStyle: "medium" });
  return (
    <div>
      <PageHeader title="Status" />
      <p className="mb-3 text-sm text-muted-foreground">
        Live checks with free read calls only (no image generation, no Etsy writes). Checked {at} Zurich{h.cached ? " (cached, 60 s)" : ""}.{" "}
        <Link href="/status?fresh=1" className="underline">Re-check</Link>
      </p>
      <Panel className="divide-y divide-border overflow-hidden">
        {h.probes.map((p) => (
          <div key={p.id} className="px-4 py-3.5">
            <div className="flex items-center gap-2.5">
              <span className={`size-2.5 rounded-full ${TONE[p.status].dot}`} aria-hidden />
              <span className="flex-1 font-medium">{p.name}</span>
              <span className="text-xs text-muted-foreground">{TONE[p.status].label}{p.latencyMs != null ? ` · ${p.latencyMs} ms` : ""}</span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{p.detail}</p>
            <p className="mt-1.5 flex flex-wrap gap-1.5">
              {Object.entries(p.env).map(([k, v]) => (
                <code key={k} className={`rounded px-1.5 py-0.5 text-[11px] ${v ? "bg-success/15 text-success" : "bg-muted text-muted-foreground line-through"}`}>{k}</code>
              ))}
            </p>
          </div>
        ))}
      </Panel>
    </div>
  );
}
