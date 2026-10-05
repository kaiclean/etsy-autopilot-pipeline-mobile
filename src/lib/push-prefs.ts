export type PushPrefKey = "order.new" | "approval.pending" | "job.failed";

export type PushPrefs = Record<PushPrefKey, boolean>;

export const DEFAULT_PUSH_PREFS: PushPrefs = {
  "order.new": true,
  "approval.pending": true,
  "job.failed": true,
};

export const PUSH_PREF_OPTIONS: { key: PushPrefKey; label: string; detail: string }[] = [
  { key: "order.new", label: "New orders", detail: "A sale was synced" },
  { key: "approval.pending", label: "Awaiting approval", detail: "A listing is waiting in the queue" },
  { key: "job.failed", label: "Failed jobs", detail: "A stage failed, a publish failed, or a listing has waited over 24 hours for an Etsy id" },
];

/** Per-event gate. listing.failed and a stalled Etsy id follow the failed-jobs switch. Unknown types stay off. */
export function pushEventEnabled(prefs: PushPrefs, type: string) {
  if (type === "listing.failed" || type === "listing.awaiting_etsy_id") return prefs["job.failed"];
  if (type === "order.new" || type === "approval.pending" || type === "job.failed") return prefs[type];
  return false;
}
