import type { StageFn } from "@/pipeline/types";

/** Adapter stage names from the multi-business plan. Pipeline stage ids map onto these. */
export const BUSINESS_STAGES = ["research", "produce", "list", "publish", "orders", "analytics"] as const;
export type BusinessStage = (typeof BUSINESS_STAGES)[number];

/** `api` publishes through the platform. `human-upload` stops at an approval packet. */
export type PublishApproval = "api" | "human-upload";

export type QualityCheck = {
  id: string;
  label: string;
};

export type BusinessAdapter = {
  kind: string;
  stages: Partial<Record<BusinessStage, StageFn>>;
  /** shop_connections providers this business needs. */
  connections: string[];
  publishApproval: PublishApproval;
  qualityChecks: QualityCheck[];
};
