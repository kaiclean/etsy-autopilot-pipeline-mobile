ALTER TABLE "designs" ADD COLUMN IF NOT EXISTS "image_width" integer;--> statement-breakpoint
ALTER TABLE "designs" ADD COLUMN IF NOT EXISTS "image_height" integer;--> statement-breakpoint
ALTER TABLE "designs" ADD COLUMN IF NOT EXISTS "color_variance" double precision;
