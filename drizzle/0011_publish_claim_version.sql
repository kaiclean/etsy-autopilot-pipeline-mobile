ALTER TABLE "listings" ADD COLUMN IF NOT EXISTS "publish_attempt_count" integer DEFAULT 0 NOT NULL;
