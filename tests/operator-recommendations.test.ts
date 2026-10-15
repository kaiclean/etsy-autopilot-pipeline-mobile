import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OpsCards } from "@/components/home/ops-cards";
import type { HealthReportPayload } from "@/db/schema";
import { recommendationsAreReviewable, type EvidenceHealthReport } from "@/lib/operator-recommendations";

const legacy: HealthReportPayload = {
  weekStart: "2026-10-12", windowStart: "2026-10-05T00:00:00Z", windowEnd: "2026-10-11T23:59:59Z",
  views: 20, favorites: 3, sales: 0, profitChf: 0, vatChf: 0, podCostChf: 0, adsChf: 0,
  suggestions: [{ listingId: 1, title: "Unsupported old recommendation", action: "retire", reason: "Legacy recommendation without checked analytics." }],
};

describe("operator recommendation display evidence", () => {
  it("withholds legacy recommendations rather than displaying them as current advice", () => {
    expect(recommendationsAreReviewable(legacy, new Date("2026-10-15T12:00:00Z"))).toBe(false);
    const html = renderToStaticMarkup(createElement(OpsCards, {
      failures: [], failureCount: 0, needsFixes: [], stalled: [],
      report: { weekStart: legacy.weekStart, payload: legacy, updatedAt: new Date("2026-10-15T12:00:00Z") },
    }));
    expect(html).toContain("Recommendations withheld");
    expect(html).not.toContain("Unsupported old recommendation");
    expect(html).toContain("Estimated profit");
    expect(html).toContain("cumulative listing snapshots");
    expect(html).toContain("No listing, inventory or ad changes are applied");
  });

  it("expires recommendations when the underlying snapshot expires, even if the report is newer", () => {
    const report: EvidenceHealthReport = {
      ...legacy,
      recommendationEvidence: {
        version: 1, mode: "listing_snapshots", freshListings: 1, totalListings: 2,
        expiresAt: "2026-10-15T12:00:00Z", humanApprovalRequired: true,
      },
    };
    expect(recommendationsAreReviewable(report, new Date("2026-10-15T11:59:59Z"))).toBe(true);
    expect(recommendationsAreReviewable(report, new Date("2026-10-15T12:00:01Z"))).toBe(false);
  });
});
