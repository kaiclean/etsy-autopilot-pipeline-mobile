ALTER TABLE "keywords" ADD COLUMN IF NOT EXISTS "design_failures" integer DEFAULT 0 NOT NULL;
