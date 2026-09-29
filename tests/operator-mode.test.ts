import { describe, expect, it } from "vitest";
import { dryRunNotice, settingsModeSubtitle } from "@/lib/operator-mode";

describe("dry-run operator notice", () => {
  it("warns that real database rows can sit behind simulated publishes", () => {
    expect(dryRunNotice({ publishMode: "dry-run", demo: false })).toEqual({
      title: "DRY-RUN — no live Etsy/Printify publishes",
      detail: "Listings and orders may be real database rows. Publishes are simulated.",
    });
  });

  it("calls out demo data separately from the publish warning", () => {
    expect(dryRunNotice({ publishMode: "dry-run", demo: true })).toEqual({
      title: "DRY-RUN — no live Etsy/Printify publishes",
      detail: "Demo data is on. Nothing is sent to Etsy or Printify.",
    });
  });

  it("stays hidden when publishing is live", () => {
    expect(dryRunNotice({ publishMode: "live", demo: false })).toBeNull();
    expect(dryRunNotice({ publishMode: "live", demo: true })).toBeNull();
  });
});

describe("settings mode subtitle", () => {
  it("does not call dry-run data live", () => {
    expect(settingsModeSubtitle({ publishMode: "dry-run", demo: false })).toBe(
      "Database rows may be real · dry-run publishes are simulated",
    );
    expect(settingsModeSubtitle({ publishMode: "dry-run", demo: true })).toContain("Demo data");
    expect(settingsModeSubtitle({ publishMode: "live", demo: false })).toBe("Live publishing is on");
  });
});
