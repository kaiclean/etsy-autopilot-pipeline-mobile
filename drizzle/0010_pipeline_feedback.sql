ALTER TABLE "listings" ADD COLUMN IF NOT EXISTS "analytics_checked_at" timestamp with time zone;
--> statement-breakpoint
-- These historical rows recorded configured budgets, not actual spend; estimates are excluded from actual net profit.
UPDATE "costs" SET "kind" = 'ads_estimate' WHERE "kind" = 'ads';
