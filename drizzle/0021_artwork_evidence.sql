ALTER TABLE designs ADD COLUMN IF NOT EXISTS provenance jsonb;
--> statement-breakpoint
ALTER TABLE listings ADD COLUMN IF NOT EXISTS gallery jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
ALTER TABLE listings ADD COLUMN IF NOT EXISTS delivery_pack jsonb;
--> statement-breakpoint
ALTER TABLE listings ADD COLUMN IF NOT EXISTS copy_provenance jsonb;
