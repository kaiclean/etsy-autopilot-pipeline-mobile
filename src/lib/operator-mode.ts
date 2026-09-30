export type PublishMode = "dry-run" | "live";

export type OperatorMode = {
  publishMode: PublishMode;
  demo: boolean;
};

export type DryRunNotice = {
  title: string;
  detail: string;
};

/** Persistent dashboard copy. Null when publishing is live. */
export function dryRunNotice(mode: OperatorMode): DryRunNotice | null {
  if (mode.publishMode !== "dry-run") return null;
  return {
    title: "DRY-RUN — no live Etsy/Printify publishes",
    detail: mode.demo
      ? "Demo data is on. Nothing is sent to Etsy or Printify."
      : "Listings and orders may be real database rows. Publishes are simulated.",
  };
}

export function settingsModeSubtitle(mode: OperatorMode): string {
  if (mode.publishMode === "dry-run") {
    return mode.demo
      ? "Demo data · dry-run publishes (nothing is sent to Etsy or Printify)"
      : "Database rows may be real · dry-run publishes are simulated";
  }
  return mode.demo ? "Demo data · live publishing is on" : "Live publishing is on";
}
