/** Topics Printify should deliver to this app. The handler stores them and does not publish. */
export const PRINTIFY_WEBHOOK_TOPICS = [
  "order:created",
  "order:updated",
  "order:sent-to-production",
  "order:shipment:created",
  "order:shipment:delivered",
  "product:publish:started",
] as const;

/** Stage paths an external scheduler should hit. Matches the default schedules. */
export const CRON_STAGE_PATHS = ["research", "design", "listing", "produce", "publish", "promote", "orders", "analytics"] as const;

/** Callback path, or the absolute URL when APP_URL's origin is known. No secrets. */
export function printifyCallbackUrl(origin: string | undefined) {
  const base = origin?.replace(/\/$/, "");
  return base ? `${base}/api/webhooks/printify` : "/api/webhooks/printify";
}

/**
 * Copy-ready crontab notes. Uses the literal `$CRON_SECRET` placeholder.
 * Callers must not pass a real secret into `origin`.
 */
export function externalCronExample(origin: string | undefined) {
  const base = origin?.replace(/\/$/, "") || "$APP_URL";
  return [
    "# Railway does not run these schedules.",
    "# Preferred: .github/workflows/autopilot-cron.yml on the default branch.",
    "# After merge, set GitHub repository secrets CRON_SECRET (same value as Railway) and optional AUTOPILOT_URL.",
    "# If AUTOPILOT_URL is empty, the workflow uses the production Railway URL. Do not paste the real secret here.",
    "# Manual fallback: GET /api/cron/<stage> with Authorization: Bearer $CRON_SECRET.",
    ...CRON_STAGE_PATHS.map((stage) => `curl -fsS -H "Authorization: Bearer $CRON_SECRET" "${base}/api/cron/${stage}"`),
  ].join("\n");
}

export type PrintifyEventLogInput = {
  id: number;
  eventId: string;
  topic: string;
  createdAt: Date | string;
  verified: boolean;
};

export type PrintifyEventLogRow = {
  id: number;
  eventId: string;
  topic: string;
  createdAt: string;
  verified: boolean;
};

/** Ids, topics, and timestamps only. Extra fields such as payload are dropped. */
export function printifyEventLog(rows: PrintifyEventLogInput[]): PrintifyEventLogRow[] {
  return rows.map((row) => ({
    id: row.id,
    eventId: row.eventId,
    topic: row.topic,
    createdAt: new Date(row.createdAt).toISOString(),
    verified: row.verified,
  }));
}
