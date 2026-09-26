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
  return (
    <div className="space-y-3">
      <Panel className="relative overflow-hidden p-4 md:p-5">
        <div className="pointer-events-none absolute -top-24 -right-16 size-64 rounded-full bg-primary/10 blur-3xl" />
        <div className="relative flex items-start justify-between gap-3">
          <div>
            <div className="text-[13px] font-medium text-muted-foreground">Net profit after fees &amp; costs</div>
            <div className="tabular mt-1 text-[40px] leading-none font-semibold tracking-tight md:text-5xl">{chf(cur.net)}</div>
            <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              <Delta cur={cur.net} prev={prev.net} /> <span>{vsLabel}</span>
            </div>
          </div>
        </div>
        <div role="tablist" aria-label="Range" className="relative mt-4 grid grid-cols-3 rounded-xl bg-muted/70 p-1">
          {RANGES.map((r) => (
            <button
              key={r.id}
              role="tab"
              aria-selected={range === r.id}
              onClick={() => setRange(r.id)}
              className={cn(
                "h-9 rounded-lg text-[13px] font-semibold transition-all",
                range === r.id ? "bg-background text-foreground shadow-sm" : "text-muted-foreground",
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
        <ChartContainer config={chartConfig} className="relative -mx-1 mt-3 aspect-auto h-28 w-[calc(100%+0.5rem)]">
          <AreaChart data={series} margin={{ left: 4, right: 4, top: 6, bottom: 0 }}>
            <defs>
              <linearGradient id="fillProfit" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-profit)" stopOpacity={0.45} />
                <stop offset="100%" stopColor="var(--color-profit)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis dataKey="date" hide />
            <ChartTooltip cursor={false} content={<ChartTooltipContent labelFormatter={(v) => shortDate(String(v))} formatter={(v, n) => [chf(Number(v)), n === "profit" ? " Profit" : " Revenue"]} />} />
            <Area dataKey="profit" type="monotone" stroke="var(--color-profit)" strokeWidth={2} fill="url(#fillProfit)" />
          </AreaChart>
        </ChartContainer>
        <div className="relative flex justify-between text-[11px] text-muted-foreground">
          <span>{shortDate(series[0].date)}</span>
          <span>Profit, last 30 days</span>
          <span>Today</span>
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
