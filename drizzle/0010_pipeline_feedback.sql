ALTER TABLE "listings" ADD COLUMN IF NOT EXISTS "analytics_checked_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN IF NOT EXISTS "publish_attempt_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- These historical rows recorded configured budgets, not actual spend; estimates are excluded from actual net profit.
UPDATE "costs" SET "kind" = 'ads_estimate' WHERE "kind" = 'ads';
