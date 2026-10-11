ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'etsy' NOT NULL;
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "parent_id" uuid;
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "config" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "shops" ADD CONSTRAINT "shops_parent_id_shops_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
UPDATE "shops"
SET "kind" = 'etsy',
	"etsy_shop_id" = COALESCE("etsy_shop_id", '68255203'),
	"config" = COALESCE("config", '{}'::jsonb) || '{"businessNumber":1}'::jsonb,
	"updated_at" = now()
WHERE "etsy_shop_id" = '68255203'
	OR ("slug" = 'omnishop-ch' AND ("etsy_shop_id" IS NULL OR "etsy_shop_id" = '68255203'));
--> statement-breakpoint
INSERT INTO "shops" ("slug", "display_name", "kind", "parent_id", "status", "publish_mode", "kill_switch", "currency", "locale", "config")
SELECT 'pinterest', 'Pinterest', 'pinterest', s."id", 'dry-run', 'dry-run', false, 'CHF', 'en', '{"board":"Etsy listings","dailyAiCapChf":0}'::jsonb
FROM "shops" s
WHERE s."kind" = 'etsy'
	AND (s."etsy_shop_id" = '68255203' OR s."slug" = 'omnishop-ch')
ON CONFLICT ("slug") DO NOTHING;
--> statement-breakpoint
INSERT INTO "shop_automation" ("shop_id", "automation", "stages")
SELECT "id", '{"publishMode":"dry-run","killSwitch":false,"dailyAiCapChf":0}'::jsonb, '{}'::jsonb
FROM "shops"
WHERE "slug" = 'pinterest'
ON CONFLICT ("shop_id") DO NOTHING;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "approval_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"listing_id" integer,
	"action" text NOT NULL,
	"status" text DEFAULT 'pending_approval' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "approval_items" ADD CONSTRAINT "approval_items_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "approval_items" ADD CONSTRAINT "approval_items_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "approval_items_business_listing_action" ON "approval_items" ("shop_id", "listing_id", "action");
