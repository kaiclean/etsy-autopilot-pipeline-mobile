import { feeScheduleStatus } from "@/lib/fee-schedule";
import type { FeeBreakdown as FB } from "@/lib/fees";
import { chf } from "@/lib/format";
import { cn } from "@/lib/utils";

export function FeeBreakdown({ fees, className, costNote }: { fees: FB; className?: string; costNote?: string | null }) {
  const stale = feeScheduleStatus().message;
  const offsiteLabel = fees.offsiteAdsCapped
    ? "Offsite Ads (USD 100 cap)"
    : `Offsite Ads ${Math.round(fees.offsiteAdsRate * 100)}%`;
  const rows: [string, number, string?][] = [
    ["Price", fees.revenueChf],
    ["Listing fee (USD 0.20)", -fees.listingFeeChf],
    ["Transaction 6.5%", -fees.transactionFeeChf],
    ["Processing 4% + CHF 0.50", -fees.processingFeeChf],
    ["VAT 8.1% on fees, including Offsite Ads", -fees.vatOnFeesChf],
  ];
  if (fees.offsiteAdsFeeChf) rows.push([offsiteLabel, -fees.offsiteAdsFeeChf]);
  if (fees.podCostChf) rows.push(["POD blank + shipping", -fees.podCostChf]);
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
      {costNote && <p className="mt-2 text-[11px] leading-snug text-muted-foreground">{costNote}</p>}
      {stale && <p className="mt-2 text-[11px] leading-snug text-warning">{stale}</p>}
      <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
        Suggested prices assume a buyer outside Switzerland, so processing excludes destination VAT. Orders to CH use the tax on the receipt. Printify prices are sent as CHF cents.
      </p>
    </div>
  );
}
