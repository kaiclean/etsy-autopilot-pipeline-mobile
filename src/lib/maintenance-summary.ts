export type MaintenanceSummaryView = {
  webhooks: { existing: number; created: number; skipped: number; reason: string | null };
  images: { rewritten: number; remaining: number; reason: string | null };
  fakeRows: {
    orders: number;
    costs: number;
    daily_stats: number;
    job_runs: number;
    events: number;
    reason: string | null;
  };
};

function isSummary(value: unknown): value is MaintenanceSummaryView {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<MaintenanceSummaryView>;
  return Boolean(row.webhooks && row.images && row.fakeRows);
}

/** Turn a stored maintenance JSON summary into a sentence. Other text is unchanged. */
export function formatMaintenanceSummary(summary: string | null | undefined): string {
  if (!summary) return "";
  try {
    const parsed = JSON.parse(summary) as unknown;
    if (!isSummary(parsed)) return summary;
    const ok = Number(parsed.webhooks.existing) + Number(parsed.webhooks.created);
    const skipped = Number(parsed.webhooks.skipped) || 0;
    const benign = parsed.webhooks.reason === "demo mode" || parsed.webhooks.reason === "dry-run";
    const webhooks =
      parsed.webhooks.reason && ok === 0
        ? benign
          ? `${skipped} ok`
          : `skipped (${parsed.webhooks.reason})`
        : skipped > 0 && parsed.webhooks.reason
          ? `${ok} ok, ${skipped} failed`
          : `${ok} ok`;
    const cleaned = Number(parsed.fakeRows.orders) || 0;
    const fakeReason = parsed.fakeRows.reason;
    const fakeBenign = !fakeReason || fakeReason === "demo mode" || fakeReason === "dry-run";
    const fake = fakeBenign
      ? `${cleaned} fake order${cleaned === 1 ? "" : "s"} cleaned`
      : "fake-order cleanup skipped";
    const parts = [`Webhooks ${webhooks}`, fake];
    if (parsed.images.rewritten > 0) parts.push(`${parsed.images.rewritten} images stored`);
    return parts.join(" · ");
  } catch {
    return summary;
  }
}
