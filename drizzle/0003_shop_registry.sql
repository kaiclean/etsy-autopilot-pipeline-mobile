CREATE TABLE "shops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"etsy_shop_id" text,
	"etsy_shop_name" text,
	"currency" text DEFAULT 'CHF' NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"market_locale" text,
	"status" text DEFAULT 'dry-run' NOT NULL,
	"publish_mode" text DEFAULT 'dry-run' NOT NULL,
	"kill_switch" boolean DEFAULT false NOT NULL,
	"brand_brief_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shops_slug_unique" UNIQUE("slug"),
	CONSTRAINT "shops_etsy_shop_id_unique" UNIQUE("etsy_shop_id")
);
--> statement-breakpoint
CREATE TABLE "shop_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"status" text NOT NULL,
	"secrets_ref" text NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tokens" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shop_connections_shop_provider" UNIQUE("shop_id","provider")
);
--> statement-breakpoint
CREATE TABLE "shop_automation" (
	"shop_id" uuid PRIMARY KEY NOT NULL,
	"automation" jsonb NOT NULL,
	"stages" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shop_connections" ADD CONSTRAINT "shop_connections_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "shop_automation" ADD CONSTRAINT "shop_automation_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
INSERT INTO "shops" ("slug", "display_name", "etsy_shop_name", "currency", "locale", "market_locale", "status", "publish_mode", "kill_switch")
VALUES ('omnishop-ch', 'OmniShop CH', 'OmniShopByKaiArt', 'CHF', 'en', 'de-CH', 'dry-run', 'dry-run', false)
ON CONFLICT ("slug") DO NOTHING;
--> statement-breakpoint
UPDATE "shops" SET
	"publish_mode" = CASE
		WHEN coalesce((SELECT value->>'publishMode' FROM "settings" WHERE key = 'automation'), 'dry-run') = 'live' THEN 'live'
		ELSE 'dry-run'
	END,
	"status" = CASE
		WHEN coalesce((SELECT value->>'publishMode' FROM "settings" WHERE key = 'automation'), 'dry-run') = 'live' THEN 'live'
		ELSE 'dry-run'
	END,
	"updated_at" = now()
WHERE "slug" = 'omnishop-ch';
--> statement-breakpoint
INSERT INTO "shop_automation" ("shop_id", "automation", "stages")
SELECT "id",
	coalesce((SELECT value FROM "settings" WHERE key = 'automation'), '{}'::jsonb),
	coalesce((SELECT value FROM "settings" WHERE key = 'stages'), '{}'::jsonb)
FROM "shops"
WHERE "slug" = 'omnishop-ch'
ON CONFLICT ("shop_id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "shop_connections" ("shop_id", "provider", "status", "secrets_ref", "meta", "tokens")
SELECT "id", 'etsy',
	CASE WHEN (SELECT value->>'accessToken' FROM "settings" WHERE key = 'etsyTokens') IS NOT NULL THEN 'connected' ELSE 'missing' END,
	'ETSY_',
	'{}'::jsonb,
	(SELECT value FROM "settings" WHERE key = 'etsyTokens')
FROM "shops"
WHERE "slug" = 'omnishop-ch'
ON CONFLICT ("shop_id", "provider") DO NOTHING;
--> statement-breakpoint
INSERT INTO "shop_connections" ("shop_id", "provider", "status", "secrets_ref", "meta")
SELECT shops.id, providers.provider, 'missing', providers.secrets_ref, '{}'::jsonb
FROM "shops" AS shops
CROSS JOIN (VALUES ('printify', 'PRINTIFY_'), ('s3', 'S3_'), ('openrouter', 'OPENROUTER_')) AS providers(provider, secrets_ref)
WHERE shops.slug = 'omnishop-ch'
ON CONFLICT ("shop_id", "provider") DO NOTHING;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION current_omnishop_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
	SELECT id FROM shops WHERE slug = 'omnishop-ch' LIMIT 1
$$;
--> statement-breakpoint
ALTER TABLE "keywords" ADD COLUMN "shop_id" uuid;
--> statement-breakpoint
ALTER TABLE "designs" ADD COLUMN "shop_id" uuid;
--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "shop_id" uuid;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shop_id" uuid;
--> statement-breakpoint
ALTER TABLE "job_runs" ADD COLUMN "shop_id" uuid;
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "shop_id" uuid;
--> statement-breakpoint
ALTER TABLE "costs" ADD COLUMN "shop_id" uuid;
--> statement-breakpoint
UPDATE "keywords" SET "shop_id" = current_omnishop_id() WHERE "shop_id" IS NULL;
--> statement-breakpoint
UPDATE "designs" SET "shop_id" = current_omnishop_id() WHERE "shop_id" IS NULL;
--> statement-breakpoint
UPDATE "listings" SET "shop_id" = current_omnishop_id() WHERE "shop_id" IS NULL;
--> statement-breakpoint
UPDATE "orders" SET "shop_id" = current_omnishop_id() WHERE "shop_id" IS NULL;
--> statement-breakpoint
UPDATE "job_runs" SET "shop_id" = current_omnishop_id() WHERE "shop_id" IS NULL;
--> statement-breakpoint
UPDATE "events" SET "shop_id" = current_omnishop_id() WHERE "shop_id" IS NULL;
--> statement-breakpoint
UPDATE "costs" SET "shop_id" = current_omnishop_id() WHERE "shop_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "keywords" ALTER COLUMN "shop_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "designs" ALTER COLUMN "shop_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "listings" ALTER COLUMN "shop_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "shop_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "job_runs" ALTER COLUMN "shop_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "shop_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "costs" ALTER COLUMN "shop_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "keywords" ALTER COLUMN "shop_id" SET DEFAULT current_omnishop_id();
--> statement-breakpoint
ALTER TABLE "designs" ALTER COLUMN "shop_id" SET DEFAULT current_omnishop_id();
--> statement-breakpoint
ALTER TABLE "listings" ALTER COLUMN "shop_id" SET DEFAULT current_omnishop_id();
--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "shop_id" SET DEFAULT current_omnishop_id();
--> statement-breakpoint
ALTER TABLE "job_runs" ALTER COLUMN "shop_id" SET DEFAULT current_omnishop_id();
--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "shop_id" SET DEFAULT current_omnishop_id();
--> statement-breakpoint
ALTER TABLE "costs" ALTER COLUMN "shop_id" SET DEFAULT current_omnishop_id();
--> statement-breakpoint
ALTER TABLE "keywords" ADD CONSTRAINT "keywords_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "designs" ADD CONSTRAINT "designs_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "costs" ADD CONSTRAINT "costs_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;
