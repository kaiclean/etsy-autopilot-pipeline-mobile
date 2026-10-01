"use client";

import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { dailyStatsCsv, type DailyStatCsvRow } from "@/lib/analytics-csv";

export function AnalyticsExport({ rows }: { rows: DailyStatCsvRow[] }) {
  return (
    <Button
      type="button"
      variant="secondary"
      className="h-9 rounded-xl px-3 text-xs"
      onClick={() => {
        const csv = dailyStatsCsv(rows);
        const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = "designed-by-kai-daily-stats.csv";
        link.click();
        URL.revokeObjectURL(url);
      }}
    >
      <Download /> Export CSV
    </Button>
  );
}
