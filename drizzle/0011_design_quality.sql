ALTER TABLE "designs" ADD COLUMN IF NOT EXISTS "quality_score" integer;
--> statement-breakpoint
ALTER TABLE "designs" ADD COLUMN IF NOT EXISTS "quality_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL;
