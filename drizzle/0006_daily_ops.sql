-- Idempotent. Drizzle applies each statement on its own over Neon HTTP, with no transaction.
-- A partial run must succeed when the file is applied again. 0005 belongs to the pricing PR.
CREATE TABLE IF NOT EXISTS "design_briefs" (
	"id" serial PRIMARY KEY NOT NULL,
	"shop_id" uuid DEFAULT current_omnishop_id() NOT NULL,
	"keyword_id" integer NOT NULL,
	"niche" text NOT NULL,
	"prompt" text NOT NULL,
	"product_type" text NOT NULL,
	"pod_preset" text,
	"day_key" text NOT NULL,
	"status" text DEFAULT 'briefed' NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "health_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"shop_id" uuid DEFAULT current_omnishop_id() NOT NULL,
	"week_start" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sale_alerts" (
	"etsy_receipt_id" text PRIMARY KEY NOT NULL,
	"shop_id" uuid,
	"alerted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "design_briefs_keyword_id_unique" ON "design_briefs" ("keyword_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "health_reports_shop_week" ON "health_reports" ("shop_id", "week_start");
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "design_briefs" ADD CONSTRAINT "design_briefs_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "design_briefs" ADD CONSTRAINT "design_briefs_keyword_id_keywords_id_fk" FOREIGN KEY ("keyword_id") REFERENCES "public"."keywords"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "health_reports" ADD CONSTRAINT "health_reports_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "sale_alerts" ADD CONSTRAINT "sale_alerts_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "fulfillment_changed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "fulfillment_stalled_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "orders" SET "fulfillment_changed_at" = "updated_at" WHERE "fulfillment_changed_at" IS NULL;
