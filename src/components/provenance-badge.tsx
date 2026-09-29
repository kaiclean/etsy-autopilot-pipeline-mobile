import { PROVENANCE_HINT, PROVENANCE_LABEL, type ProvenanceKind } from "@/lib/provenance";
import { cn } from "@/lib/utils";

const STYLE: Record<ProvenanceKind, string> = {
  demo: "bg-warning/15 text-warning",
  "dry-run": "bg-chart-4/15 text-chart-4",
  live: "bg-success/15 text-success",
};

const SOLID: Record<ProvenanceKind, string> = {
  demo: "bg-warning text-black",
  "dry-run": "bg-chart-4 text-black",
  live: "bg-success text-black",
};

export function ProvenanceBadge({ kind, solid, className }: { kind: ProvenanceKind; solid?: boolean; className?: string }) {
  return (
    <span
      title={PROVENANCE_HINT[kind]}
      className={cn(
        "inline-flex h-5 items-center rounded-full px-2 text-[11px] font-semibold whitespace-nowrap",
        solid ? SOLID[kind] : STYLE[kind],
        className,
      )}
    >
      {PROVENANCE_LABEL[kind]}
    </span>
  );
}
