export const PUSH_PREF_KEYS = ["order.new", "approval.pending", "job.failed", "health.report", "fulfillment.stalled"] as const;

export type PushPrefKey = (typeof PUSH_PREF_KEYS)[number];

export type PushPrefs = Record<PushPrefKey, boolean>;

export const DEFAULT_PUSH_PREFS: PushPrefs = {
  "order.new": true,
  "approval.pending": true,
  "job.failed": true,
  "health.report": true,
  "fulfillment.stalled": true,
};

export const PUSH_PREF_OPTIONS: { key: PushPrefKey; label: string; detail: string }[] = [
  { key: "order.new", label: "New orders", detail: "A real sale was synced. Demo and dry-run receipts stay quiet." },
  { key: "approval.pending", label: "Awaiting approval", detail: "A listing is waiting in the queue" },
  { key: "job.failed", label: "Failed jobs", detail: "A stage failed, a publish failed, or a listing has waited over 24 hours for an Etsy id" },
  { key: "health.report", label: "Monday health", detail: "The weekly shop report" },
  { key: "fulfillment.stalled", label: "Stalled Printify orders", detail: "A Printify order has not moved for 48 hours" },
];

/** Per-event gate. listing.failed and a stalled Etsy id follow the failed-jobs switch. Unknown types stay off. */
export function pushEventEnabled(prefs: PushPrefs, type: string) {
  if (type === "listing.failed" || type === "listing.awaiting_etsy_id") return prefs["job.failed"];
  if ((PUSH_PREF_KEYS as readonly string[]).includes(type)) return prefs[type as PushPrefKey];
  return false;
}
