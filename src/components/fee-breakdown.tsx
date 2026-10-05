import type { FeeBreakdown as FB } from "@/lib/fees";
import { chf } from "@/lib/format";
import { cn } from "@/lib/utils";

export function FeeBreakdown({ fees, className }: { fees: FB; className?: string }) {
  const rows: [string, number, string?][] = [
    ["Price", fees.revenueChf],
    ["Listing fee (USD 0.20)", -fees.listingFeeChf],
    ["Transaction 6.5%", -fees.transactionFeeChf],
    ["Processing 4% + CHF 0.50", -fees.processingFeeChf],
    ["VAT 8.1% on fees", -fees.vatOnFeesChf],
  ];
  if (fees.offsiteAdsFeeChf) rows.push(["Offsite Ads 15%", -fees.offsiteAdsFeeChf]);
  if (fees.podCostChf) rows.push(["POD base + shipping", -fees.podCostChf]);
  const good = fees.podCostChf > 0 ? fees.marginPct >= 25 : fees.marginPct >= 75;
  return (
    <div className={cn("rounded-xl border border-border bg-muted/30 p-3", className)}>
      <div className="space-y-1.5 text-[13px]">
        {rows.map(([label, v]) => (
          <div key={label} className="flex justify-between gap-3">
            <span className="text-muted-foreground">{label}</span>
            <span className={cn("tabular", v < 0 ? "text-muted-foreground" : "font-medium")}>{chf(v)}</span>
          </div>
        ))}
      </div>
      <div className="mt-2.5 flex items-baseline justify-between border-t border-border pt-2.5">
        <span className="text-sm font-semibold">Net per sale</span>
        <span className="flex items-baseline gap-2">
          <span className={cn("tabular text-lg font-semibold", fees.netChf <= 0 ? "text-destructive" : "text-foreground")}>{chf(fees.netChf)}</span>
          <span className={cn("tabular text-xs font-semibold", good ? "text-success" : "text-warning")}>{fees.marginPct.toFixed(1)}%</span>
        </span>
      </div>
    </div>
  );
}
