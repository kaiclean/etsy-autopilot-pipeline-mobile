-- Idempotent. Drizzle applies each statement on its own over Neon HTTP, with no transaction.
-- A partial run must succeed when the file is applied again.
ALTER TABLE "listings" ADD COLUMN IF NOT EXISTS "publish_attempted_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "listings"
SET "publish_attempted_at" = "updated_at"
WHERE "publish_attempted_at" IS NULL
  AND "publish_error" IS NOT NULL
  AND "status" = 'failed';
