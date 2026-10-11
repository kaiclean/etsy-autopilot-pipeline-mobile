import type { StageName } from "@/db/schema";
import type { StageFn } from "@/pipeline/types";
import { etsyAdapter } from "./etsy";
import { pinterestAdapter } from "./pinterest";
import type { BusinessAdapter, BusinessStage } from "./types";

const ADAPTERS: Record<string, BusinessAdapter> = {
  etsy: etsyAdapter,
  pinterest: pinterestAdapter,
};

export function getBusinessAdapter(kind: string | null | undefined): BusinessAdapter | null {
  if (!kind) return etsyAdapter;
  return ADAPTERS[kind] ?? null;
}

/** Pipeline stage ids the runner already schedules, mapped onto adapter stages. */
export const PIPELINE_STAGE: Partial<Record<StageName, BusinessStage>> = {
  research: "research",
  design: "produce",
  listing: "list",
  publish: "publish",
  orders: "orders",
  analytics: "analytics",
};

export function adapterStageFn(kind: string, stage: StageName, etsyOnly: Partial<Record<StageName, StageFn>>): StageFn | null {
  const mapped = PIPELINE_STAGE[stage];
  if (mapped) return getBusinessAdapter(kind)?.stages[mapped] ?? null;
  if (kind === "etsy") return etsyOnly[stage] ?? null;
  return null;
}

export type { BusinessAdapter, BusinessStage, PublishApproval, QualityCheck } from "./types";
export { etsyAdapter } from "./etsy";
export { pinterestAdapter } from "./pinterest";
