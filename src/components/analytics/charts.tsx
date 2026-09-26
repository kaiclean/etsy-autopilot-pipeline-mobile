"use client";

import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Panel, SectionTitle } from "@/components/common";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { chf, num, shortDate } from "@/lib/format";

type Series = { date: string; revenue: number; profit: number; orders: number; views: number }[];
type Niche = { id: string; label: string; revenue: number; profit: number; orders: number; listings: number; views: number };

const revConfig = {
  revenue: { label: "Revenue", color: "var(--chart-4)" },
  profit: { label: "Profit after fees", color: "var(--chart-1)" },
} satisfies ChartConfig;

export function RevenueChart({ series }: { series: Series }) {
  return (
    <Panel className="p-4">
      <SectionTitle>Revenue vs profit · 30 days</SectionTitle>
      <ChartContainer config={revConfig} className="aspect-auto h-56 w-full">
        <AreaChart data={series} margin={{ left: 0, right: 8, top: 8 }}>
          <defs>
            {(["revenue", "profit"] as const).map((k) => (
              <linearGradient key={k} id={`g-${k}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={`var(--color-${k})`} stopOpacity={0.35} />
                <stop offset="100%" stopColor={`var(--color-${k})`} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid vertical={false} strokeOpacity={0.15} />
          <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} minTickGap={28} tickFormatter={(v) => shortDate(v)} fontSize={11} />
          <YAxis tickLine={false} axisLine={false} width={36} fontSize={11} />
          <ChartTooltip content={<ChartTooltipContent labelFormatter={(v) => shortDate(String(v))} formatter={(v, n) => [chf(Number(v)), ` ${revConfig[n as "revenue"].label}`]} />} />
          <Area dataKey="revenue" type="monotone" stroke="var(--color-revenue)" fill="url(#g-revenue)" strokeWidth={2} />
          <Area dataKey="profit" type="monotone" stroke="var(--color-profit)" fill="url(#g-profit)" strokeWidth={2} />
          <ChartLegend content={<ChartLegendContent />} />
        </AreaChart>
      </ChartContainer>
    </Panel>
  );
}

const trafficConfig = {
  views: { label: "Views", color: "var(--chart-5)" },
  orders: { label: "Orders", color: "var(--chart-3)" },
} satisfies ChartConfig;

export function TrafficChart({ series }: { series: Series }) {
  return (
    <Panel className="p-4">
      <SectionTitle>Views &amp; orders per day</SectionTitle>
      <ChartContainer config={trafficConfig} className="aspect-auto h-48 w-full">
        <BarChart data={series} margin={{ left: 0, right: 0, top: 8 }}>
          <CartesianGrid vertical={false} strokeOpacity={0.15} />
          <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} minTickGap={28} tickFormatter={(v) => shortDate(v)} fontSize={11} />
          <YAxis yAxisId="v" tickLine={false} axisLine={false} width={32} fontSize={11} />
          <YAxis yAxisId="o" orientation="right" tickLine={false} axisLine={false} width={24} fontSize={11} />
          <ChartTooltip content={<ChartTooltipContent labelFormatter={(v) => shortDate(String(v))} />} />
          <Bar yAxisId="v" dataKey="views" fill="var(--color-views)" radius={[3, 3, 0, 0]} opacity={0.55} />
          <Bar yAxisId="o" dataKey="orders" fill="var(--color-orders)" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ChartContainer>
    </Panel>
  );
}

const nicheConfig = { profit: { label: "Profit", color: "var(--chart-1)" } } satisfies ChartConfig;

export function NicheChart({ niches }: { niches: Niche[] }) {
  const data = [...niches].sort((a, b) => b.profit - a.profit);
  return (
    <Panel className="p-4">
      <SectionTitle>Profit by niche · 30 days</SectionTitle>
      <ChartContainer config={nicheConfig} className="aspect-auto h-52 w-full">
        <BarChart data={data} layout="vertical" margin={{ left: 0, right: 16 }}>
          <XAxis type="number" hide />
          <YAxis type="category" dataKey="label" tickLine={false} axisLine={false} width={72} fontSize={12} />
          <ChartTooltip content={<ChartTooltipContent formatter={(v) => [chf(Number(v)), " Profit"]} />} />
          <Bar dataKey="profit" fill="var(--color-profit)" radius={6} barSize={18} />
        </BarChart>
      </ChartContainer>
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-muted-foreground md:grid-cols-3">
        {data.map((n) => (
          <div key={n.id} className="flex justify-between">
            <span>{n.label}</span>
            <span className="tabular">{num(n.orders)} ord · {n.views ? ((n.orders / n.views) * 100).toFixed(1) : "0.0"}% cvr</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}
