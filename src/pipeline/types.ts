import type { DB } from "@/db";
import type { LogLine, StageName } from "@/db/schema";

export type StageContext = {
  db: DB;
  shopId: string;
  trigger: "manual" | "cron" | "chain";
  random: () => number;
  now: Date;
  log: (msg: string, level?: LogLine["level"]) => void;
};

export type StageFn = (ctx: StageContext) => Promise<string>;

export const STAGES: { id: StageName; label: string; description: string }[] = [
  { id: "research", label: "Research", description: "Collect and score keyword & trend candidates" },
  { id: "design", label: "Design", description: "Generate artwork via the image provider" },
  { id: "listing", label: "Listing", description: "Write titles, tags, descriptions & price with fee math" },
  { id: "publish", label: "Publish", description: "Push approved items to Etsy / Printify" },
  { id: "orders", label: "Orders", description: "Sync receipts and POD fulfillment" },
  { id: "analytics", label: "Analytics", description: "Pull views, favorites and roll up stats" },
];

export const STAGE_IDS = STAGES.map((s) => s.id);

export function isStage(s: string): s is StageName {
  return (STAGE_IDS as string[]).includes(s);
}
