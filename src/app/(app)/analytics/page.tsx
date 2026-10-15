import { AnalyticsExport } from "@/components/analytics/export-csv";
import { FinanceImport } from "@/components/analytics/finance-import";
import { NicheChart, RevenueChart, TrafficChart } from "@/components/analytics/charts";
import { NicheTag, PageHeader, Panel, SectionTitle, Thumb } from "@/components/common";
import { chf, num, pct } from "@/lib/format";
import { ANALYTICS_FRESHNESS_HOURS, getAnalytics } from "@/lib/queries";
import { getDb } from "@/db";
import { getFinancialEvidence } from "@/lib/etsy-finance";
import { resolveRequestShop } from "@/lib/shops";

export const metadata = { title: "Analytics" };

export default async function AnalyticsPage() {
  const a = await getAnalytics();
  const db = await getDb();
  const shop = await resolveRequestShop(db);
  const finance = await getFinancialEvidence(db, shop.id);
  const t = a.totals;
  const lastCheckedAt = a.analyticsFreshness.lastCheckedAt
    ? `${a.analyticsFreshness.lastCheckedAt.toISOString().replace("T", " ").slice(0, 16)} UTC`
    : "no analytics check yet";
  const freshnessSummary = `Stats checked for ${a.analyticsFreshness.checked}/${a.analyticsFreshness.total} live listings in the last ${ANALYTICS_FRESHNESS_HOURS}h · last check ${lastCheckedAt}`;
  const waterfall: [string, number, string?][] = [
    ["Gross revenue", t.revenue],
    ["Etsy fees (listing, transaction, processing, VAT)", -t.etsyFees],
    ["Offsite Ads (15%, attributed)", -t.offsiteAds],
    ["POD production + shipping", -t.podCosts],
    ["AI generation", -(a.costByKind.ai_image + a.costByKind.ai_text)],
    ["Etsy Ads actual spend", -a.costByKind.ads_actual],
  ];
  return (
    <div className="space-y-5">
      <PageHeader
        title="Analytics"
        subtitle={`Last 30 days · estimates in CHF; evidence in original currency · ${freshnessSummary}`}
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
        <Stat label="Estimated net profit" value={chf(t.netProfit)} accent />
        <Stat label="Revenue" value={chf(t.revenue)} />
        <Stat label="Orders / view snapshots" value={pct(t.conversion, 2)} sub="Not a measured conversion rate" />
        <Stat label="Avg order" value={chf(t.aov)} sub={`${num(t.favorites)} favorites`} />
      </div>

      <Panel className="space-y-3 p-4">
        <SectionTitle>Financial evidence · actual profit unavailable</SectionTitle>
        <p className="text-xs text-muted-foreground">
          Existing CHF profit and fee figures remain estimates; imported evidence never overwrites them.
          Individual actual observations do not establish actual profit. Reconcile {finance.incompleteComponents.join(", ")} before making a profit claim.
          Listing views and favorites are snapshots, not verified traffic for the selected period.
        </p>
        <FinanceImport etsyShopId={shop.etsyShopId} />
        {finance.rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">No financial observations imported for this shop.</p>
        ) : (
          <div className="overflow-x-auto">
            <p className="mb-2 text-xs text-muted-foreground">Latest {finance.rows.length} observations · original units, not converted to CHF or summed across currencies</p>
            <table className="w-full text-left text-xs">
              <thead><tr><th className="p-2">Evidence date</th><th className="p-2">Component / original type</th><th className="p-2">Status</th><th className="p-2">Original amount / divisor</th><th className="p-2">Source reference</th></tr></thead>
              <tbody>{finance.rows.map((row) => (
                <tr key={row.id} className="border-t border-border">
                  <td className="p-2">{row.occurredAt.toISOString().slice(0, 10)}</td>
                  <td className="p-2">{row.component} / {row.ledgerType}</td>
                  <td className="p-2">{row.status}</td>
                  <td className="p-2 font-mono">{row.amount === null ? "Unavailable" : `${row.amount} / ${row.divisor} ${row.currency}`}</td>
                  <td className="p-2">{row.sourceKind}: {row.sourceRef} / {row.observationRef}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Panel>

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
              <span className="font-semibold">Estimated net profit</span>
              <span className="tabular font-semibold text-success">{chf(t.netProfit)}</span>
            </div>
          </div>
          <p className="mt-2.5 text-[11px] text-muted-foreground">
            Etsy Ads estimate (not actual spend): {chf(a.costByKind.ads_estimate)}. Actual ad spend is included in net profit; estimates are not deducted. Listing fees tracked: {chf(a.costByKind.listing_fee)}.
          </p>
        </Panel>
      </div>

      <div>
        <SectionTitle>Top products by estimated profit</SectionTitle>
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
