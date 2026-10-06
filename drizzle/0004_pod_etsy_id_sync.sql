ALTER TABLE "listings" ADD COLUMN IF NOT EXISTS "etsy_id_wait_alerted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "unmatched_etsy_listing_id" text;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "match_status" text;
--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "match_status" SET DEFAULT 'matched';
--> statement-breakpoint
UPDATE "orders" SET "match_status" = 'matched' WHERE "match_status" IS NULL;
--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "match_status" SET NOT NULL;
--> statement-breakpoint
-- Legacy POD rows marked published before an Etsy id existed.
UPDATE "listings"
SET "status" = 'publishing'
WHERE "status" = 'published'
  AND "product_type" = 'pod'
  AND "etsy_listing_id" IS NULL;
--> statement-breakpoint
-- Human publish already reached Printify, but the row was left in pod_created without an Etsy id.
UPDATE "listings"
SET "status" = 'publishing'
WHERE "status" = 'pod_created'
  AND "product_type" = 'pod'
  AND "etsy_listing_id" IS NULL
  AND "pod_published_at" IS NOT NULL;
