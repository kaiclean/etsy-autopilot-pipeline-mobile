-- Presigned upload keys bound to one design, and box-upscale failure tracking. Additive.
CREATE TABLE IF NOT EXISTS "upscale_uploads" (
  "key" text PRIMARY KEY NOT NULL,
  "design_id" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "consumed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "designs" ADD COLUMN IF NOT EXISTS "upscale_failure" jsonb;
