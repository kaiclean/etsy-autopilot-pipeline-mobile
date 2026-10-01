import { chf } from "@/lib/format";

export type DailyStatCsvRow = {
  date: string;
  views: number;
  favorites: number;
  orders: number;
  revenueChf: number;
  profitChf: number;
};

function cell(value: string | number) {
  const text = String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** Visible-range export. Money columns use the same CHF formatter as the dashboard. */
export function dailyStatsCsv(rows: DailyStatCsvRow[]) {
  const header = "date,views,favorites,orders,revenue_chf,profit_chf";
  const lines = rows.map((row) =>
    [row.date, row.views, row.favorites, row.orders, chf(row.revenueChf), chf(row.profitChf)].map(cell).join(","),
  );
  return [header, ...lines].join("\n");
}
