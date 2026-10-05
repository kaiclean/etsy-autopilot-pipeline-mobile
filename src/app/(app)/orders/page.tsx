import { Receipt } from "lucide-react";
import { EmptyState, FulfillmentPill, PageHeader, Panel, Thumb } from "@/components/common";
import { ProvenanceBadge } from "@/components/provenance-badge";
import { RunStageButton } from "@/components/run-button";
import { chf, countryName, flag, num, relTime } from "@/lib/format";
import { orderProvenance } from "@/lib/provenance";
import { getOrders } from "@/lib/queries";

export const metadata = { title: "Orders" };

export default async function OrdersPage() {
  const { rows, summary } = await getOrders();

  return (
    <div className="space-y-5">
      <PageHeader title="Orders" subtitle="Each row is badged Demo, Dry-run draft, or Live Etsy" action={<RunStageButton stage="orders" label="Sync" />} />

      {summary.unmatched > 0 && (
        <Panel className="flex gap-2 border-warning/30 bg-warning/10 p-3 text-xs text-warning">
          <span>
            {summary.unmatched === 1
              ? "1 receipt references an Etsy listing this pipeline does not know yet. It stays here and links automatically once that listing id is stored."
              : `${summary.unmatched} receipts reference an Etsy listing this pipeline does not know yet. They stay here and link automatically once that listing id is stored.`}
          </span>
        </Panel>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Mini label="Orders · 30d" value={num(summary.count30d)} />
        <Mini label="Revenue · 30d" value={chf(summary.revenue30d, { compact: true })} />
        <Mini label="Profit after fees" value={chf(summary.profit30d, { compact: true })} accent />
        <Mini label="Open POD orders" value={num(summary.openPod)} />
      </div>

      {rows.length === 0 ? (
        <EmptyState icon={Receipt} title="No orders yet" body="Orders sync from Etsy every run of the Orders stage. Publish a few listings first." />
      ) : (
        <Panel className="divide-y divide-border overflow-hidden">
          {rows.map(({ order: o, title, imageUrl, productType }) => (
            <div key={o.id} className="flex items-center gap-3 px-3.5 py-3">
              {imageUrl ? <Thumb src={imageUrl} alt="" className="size-12 shrink-0" /> : <div className="size-12 shrink-0 rounded-xl bg-muted" />}
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">
                  {title ?? (o.matchStatus === "unmatched" ? `Unmatched Etsy listing ${o.unmatchedEtsyListingId ?? ""}` : "Unknown listing")}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span title={countryName(o.buyerCountry)}>{flag(o.buyerCountry)} {o.buyerCountry}</span>
                  <span>·</span>
                  <span suppressHydrationWarning>{relTime(o.createdAt)}</span>
                  {o.quantity > 1 && <span>· ×{o.quantity}</span>}
                  <ProvenanceBadge kind={orderProvenance(o)} />
                  {o.matchStatus === "unmatched" ? (
                    <span className="inline-flex h-5 items-center rounded-full bg-warning/15 px-2 text-[11px] font-semibold text-warning">Unmatched</span>
                  ) : (
                    <FulfillmentPill status={o.fulfillmentStatus} />
                  )}
                  {productType === "pod" && o.podOrderId && <span className="hidden font-mono md:inline">{o.podOrderId}</span>}
                </div>
              </div>
              <div className="text-right">
                <div className="tabular text-sm font-semibold">{chf(o.totalChf)}</div>
                {o.matchStatus === "unmatched" ? (
                  <div className="text-[11px] text-warning">Profit pending</div>
                ) : (
                  <div className="tabular text-[11px] font-medium text-success">+{chf(o.profitChf).replace("CHF ", "")}</div>
                )}
                {o.offsiteAdsChf > 0 && <div className="text-[10px] text-warning">Offsite Ads</div>}
              </div>
            </div>
          ))}
        </Panel>
      )}
    </div>
  );
}

function Mini({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <Panel className="p-3.5">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className={`tabular mt-1 text-xl font-semibold tracking-tight ${accent ? "text-success" : ""}`}>{value}</div>
    </Panel>
  );
}
