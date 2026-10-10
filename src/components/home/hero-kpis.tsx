"use client";

import { useState } from "react";
import { Area, AreaChart, XAxis } from "recharts";
import { Delta, Panel } from "@/components/common";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { chf, num, pct, shortDate } from "@/lib/format";
import { cn } from "@/lib/utils";

type Totals = { revenue: number; profit: number; orders: number; costs: number; views: number; net: number; conversion: number };
type Props = {
  kpis: Record<"today" | "7d" | "30d", { cur: Totals; prev: Totals }>;
  series: { date: string; revenue: number; profit: number }[];
};

const RANGES = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
] as const;

const chartConfig = {
  profit: { label: "Profit", color: "var(--chart-1)" },
  revenue: { label: "Revenue", color: "var(--chart-4)" },
} satisfies ChartConfig;

export function HeroKpis({ kpis, series }: Props) {
  const [range, setRange] = useState<(typeof RANGES)[number]["id"]>("7d");
  const { cur, prev } = kpis[range];
  const vsLabel = range === "today" ? "vs yesterday" : `vs prior ${range}`;
  const trend = range === "today" ? series.slice(-1) : range === "7d" ? series.slice(-7) : series;
  const trendLabel = range === "today" ? "Today" : `Daily trend · ${range === "7d" ? "7 days" : "30 days"}`;
  return (
    <div className="space-y-3">
      <Panel className="relative overflow-hidden border-primary/15 bg-gradient-to-br from-card via-card to-primary/[0.07] p-4 shadow-sm md:p-5">
        <div className="pointer-events-none absolute -top-24 -right-16 size-64 rounded-full bg-primary/10 blur-3xl" />
        <div className="relative grid gap-4 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] md:items-end">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="size-2 rounded-full bg-success shadow-[0_0_12px_var(--success)]" />
              <div className="text-[13px] font-medium text-muted-foreground">Net profit after fees &amp; costs</div>
            </div>
            <div className="tabular mt-2 text-[40px] leading-none font-semibold tracking-tight md:text-5xl">{chf(cur.net)}</div>
            <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              <Delta cur={cur.net} prev={prev.net} /> <span>{vsLabel}</span>
            </div>
          </div>
          <div className="min-w-0">
            <div className="flex items-center justify-between gap-3">
              <div className="text-[11px] font-medium text-muted-foreground">{trendLabel}</div>
              <div className="flex items-center gap-3 text-[10px] font-medium text-muted-foreground">
                <span className="flex items-center gap-1"><span className="size-1.5 rounded-full bg-chart-1" /> Profit</span>
                <span className="flex items-center gap-1"><span className="size-1.5 rounded-full bg-chart-4" /> Revenue</span>
              </div>
            </div>
            <ChartContainer config={chartConfig} className="mt-1 aspect-auto h-24 w-full">
              <AreaChart data={trend} margin={{ left: 2, right: 3, top: 8, bottom: 0 }}>
                <defs>
                  <linearGradient id="fillProfit" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--color-profit)" stopOpacity={0.32} />
                    <stop offset="100%" stopColor="var(--color-profit)" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="fillRevenue" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--color-revenue)" stopOpacity={0.12} />
                    <stop offset="100%" stopColor="var(--color-revenue)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="date" hide />
                <ChartTooltip cursor={false} content={<ChartTooltipContent labelFormatter={(v) => shortDate(String(v))} formatter={(v, n) => [chf(Number(v)), n === "profit" ? " Profit" : " Revenue"]} />} />
                <Area dataKey="revenue" type="monotone" stroke="var(--color-revenue)" strokeWidth={1.5} fill="url(#fillRevenue)" dot={trend.length === 1} />
                <Area dataKey="profit" type="monotone" stroke="var(--color-profit)" strokeWidth={2} fill="url(#fillProfit)" dot={trend.length === 1} />
              </AreaChart>
            </ChartContainer>
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>{trend.length ? shortDate(trend[0].date) : "No data"}</span>
              <span>{trend.length > 1 ? shortDate(trend.at(-1)!.date) : "Current day"}</span>
            </div>
          </div>
        </div>
        <div role="group" aria-label="KPI time range" className="relative mt-4 grid grid-cols-3 rounded-xl bg-muted/70 p-1 md:max-w-sm">
          {RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              aria-pressed={range === r.id}
              onClick={() => setRange(r.id)}
              className={cn(
                "h-9 rounded-lg text-[13px] font-semibold transition-all focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                range === r.id ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
      </Panel>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Revenue" value={chf(cur.revenue)} cur={cur.revenue} prev={prev.revenue} />
        <Kpi label="Orders" value={num(cur.orders)} cur={cur.orders} prev={prev.orders} />
        <Kpi label="Conversion" value={pct(cur.conversion, 2)} cur={cur.conversion} prev={prev.conversion} />
        <Kpi label="Views" value={num(cur.views)} cur={cur.views} prev={prev.views} />
      </div>
    </div>
  );
}

function Kpi({ label, value, cur, prev }: { label: string; value: string; cur: number; prev: number }) {
  return (
    <Panel className="p-3.5">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="tabular mt-1 truncate text-xl font-semibold tracking-tight">{value}</div>
      <div className="mt-1">
        <Delta cur={cur} prev={prev} />
      </div>
    </Panel>
  );
}
