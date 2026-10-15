import type { HealthReportPayload } from "@/db/schema";

export const RECOMMENDATION_FRESHNESS_MS = 36 * 60 * 60 * 1000;

export function hasFreshListingSnapshot(checkedAt: Date | null | undefined, now: Date) {
  if (!checkedAt || !Number.isFinite(checkedAt.getTime())) return false;
  const age = now.getTime() - checkedAt.getTime();
  return age >= 0 && age <= RECOMMENDATION_FRESHNESS_MS;
}

export type EvidenceHealthReport = HealthReportPayload & {
  recommendationEvidence: {
    version: 1;
    mode: "listing_snapshots";
    freshListings: number;
    totalListings: number;
    expiresAt: string;
    humanApprovalRequired: true;
  };
};

/** Old reports and expired source snapshots must not resurrect unsupported recommendations. */
export function recommendationsAreReviewable(payload: HealthReportPayload, now = new Date()) {
  const evidence = (payload as Partial<EvidenceHealthReport>).recommendationEvidence;
  return evidence?.version === 1 && evidence.mode === "listing_snapshots"
    && evidence.humanApprovalRequired === true && Date.parse(evidence.expiresAt) >= now.getTime();
}
