export type PublishMode = "dry-run" | "live";

/** Exact text the go-live form must submit. Anything else stays dry-run. */
export const GO_LIVE_CONFIRMATION = "CONFIRM";

/** Checkbox label shown before live writes can be armed. */
export const GO_LIVE_ACK = "I understand this publishes to Etsy/Printify";

export function effectivePublishMode(value: unknown): PublishMode {
  return value === "live" ? "live" : "dry-run";
}

export function goLiveDecision(input: { mode: string; confirmation?: string; understood?: boolean }):
  | { ok: true; mode: PublishMode }
  | { ok: false; error: string } {
  if (input.mode === "dry-run") return { ok: true, mode: "dry-run" };
  if (input.mode !== "live") return { ok: false, error: "Unknown publish mode." };
  if (input.understood !== true) {
    return { ok: false, error: "Check the box to confirm this publishes to Etsy and Printify." };
  }
  if (input.confirmation !== GO_LIVE_CONFIRMATION) {
    return { ok: false, error: `Type ${GO_LIVE_CONFIRMATION} to go live.` };
  }
  return { ok: true, mode: "live" };
}
