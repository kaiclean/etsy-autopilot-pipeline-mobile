export type DashboardRange = "today" | "7d" | "30d";

export type DashboardTrendPoint = {
  date: string;
  revenue: number;
  profit: number;
};

export function dashboardTrendForRange(series: DashboardTrendPoint[], range: DashboardRange) {
  if (range === "today") return series.slice(-1);
  if (range === "7d") return series.slice(-7);
  return series;
}
