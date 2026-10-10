ALTER TABLE "listings" ADD COLUMN IF NOT EXISTS "analytics_checked_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "costs" SET "kind" = 'ads_estimate' WHERE "kind" = 'ads';
