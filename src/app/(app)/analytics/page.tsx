import { AnalyticsExport } from "@/components/analytics/export-csv";
import { NicheChart, RevenueChart, TrafficChart } from "@/components/analytics/charts";
import { NicheTag, PageHeader, Panel, SectionTitle, Thumb } from "@/components/common";
import { feeScheduleStatus } from "@/lib/fee-schedule";
import { chf, num, pct } from "@/lib/format";
import { getAnalytics } from "@/lib/queries";

export const metadata = { title: "Analytics" };

export default async function AnalyticsPage() {
  const a = await getAnalytics();
  const t = a.totals;
  const feeWarning = feeScheduleStatus().message;
  const basis =
    t.orders === 0 ? "No orders in this window." : t.reconciledOrders === t.orders ? "Reconciled with the Etsy ledger." : t.reconciledOrders === 0 ? "Estimated. Ledger matches and Printify order costs replace these figures when they are available." : `${t.reconciledOrders} reconciled, ${t.estimatedOrders} estimated.`;
  const waterfall: [string, number, string?][] = [
    ["Gross revenue", t.revenue],
    ["Etsy fees (listing, transaction, processing, VAT)", -t.etsyFees],
    ["Offsite Ads", -t.offsiteAds],
    ["POD production + shipping", -t.podCosts],
    ["Listing publish and renewal fees", -a.costByKind.listing_fee],
    ["AI generation", -(a.costByKind.ai_image + a.costByKind.ai_text)],
    ["Etsy Ads daily cap (estimate)", -a.costByKind.ads],
  ];
  return (
    <div className="space-y-5">
      <PageHeader
        title="Analytics"
        subtitle={`Last 30 days · CHF · ${basis}`}
        action={
          <AnalyticsExport
            rows={a.series.map((row) => ({
              date: row.date,
              views: row.views,
              favorites: row.favorites,
              orders: row.orders,
              revenueChf: row.revenue,
              profitChf: row.profit,
            }))}
          />
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Net profit" value={chf(t.netProfit)} accent />
        <Stat label="Revenue" value={chf(t.revenue)} />
        <Stat label="Conversion" value={pct(t.conversion, 2)} sub={`${num(t.orders)} orders / ${num(t.views)} views`} />
        <Stat label="Avg order" value={chf(t.aov)} sub={`${num(t.favorites)} favorites`} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <RevenueChart series={a.series} />
        <TrafficChart series={a.series} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <NicheChart niches={a.niches} />
        <Panel className="p-4">
          <SectionTitle>Where the money goes</SectionTitle>
          <div className="space-y-2.5">
            {waterfall.map(([label, v]) => {
              const w = t.revenue ? Math.min(100, (Math.abs(v) / t.revenue) * 100) : 0;
              return (
                <div key={label}>
                  <div className="flex justify-between text-[13px]">
                    <span className="text-muted-foreground">{label}</span>
                    <span className="tabular font-medium">{chf(v)}</span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                    <div className={`h-full rounded-full ${v >= 0 ? "bg-chart-4" : "bg-destructive/70"}`} style={{ width: `${w}%` }} />
                  </div>
                </div>
              );
            })}
            <div className="flex justify-between border-t border-border pt-2.5">
              <span className="font-semibold">Net profit</span>
              <span className="tabular font-semibold text-success">{chf(t.netProfit)}</span>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {basis} Listing publish and renewal fees are in net profit. The ads line is the daily cap, not measured spend. Dry-run listing fees are tracked and were not charged by Etsy.
              {feeWarning ? ` ${feeWarning}` : ""}
            </p>
          </div>
        </Panel>
      </div>

      <div>
        <SectionTitle>Top products by profit</SectionTitle>
        <Panel className="divide-y divide-border">
          {a.topProducts.length === 0 && <p className="p-6 text-center text-sm text-muted-foreground">No sales in the last 30 days.</p>}
          {a.topProducts.map((p, i) => (
            <div key={p.id} className="flex items-center gap-3 px-3.5 py-3">
              <span className="tabular w-4 text-xs font-semibold text-muted-foreground">{i + 1}</span>
              <Thumb src={p.imageUrl} alt="" className="size-11 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{p.title}</div>
                <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                  <NicheTag niche={p.niche as "alpine"} /> {num(p.orders)} orders · {num(p.views)} views
                </div>
              </div>
              <div className="text-right">
                <div className="tabular text-sm font-semibold text-success">{chf(p.profit)}</div>
                <div className="tabular text-[11px] text-muted-foreground">{chf(p.revenue)}</div>
              </div>
            </div>
          ))}
        </Panel>
      </div>
    </div>
  );
}

function Stat({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <Panel className="p-3.5">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className={`tabular mt-1 truncate text-xl font-semibold tracking-tight ${accent ? "text-success" : ""}`}>{value}</div>
      {sub && <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{sub}</div>}
    </Panel>
  );
}
