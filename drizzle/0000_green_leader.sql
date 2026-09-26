CREATE TABLE "costs" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"amount_chf" double precision NOT NULL,
	"note" text,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_stats" (
	"id" serial PRIMARY KEY NOT NULL,
	"date" text NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	"favorites" integer DEFAULT 0 NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "designs" (
	"id" serial PRIMARY KEY NOT NULL,
	"keyword_id" integer,
	"niche" text NOT NULL,
	"prompt" text NOT NULL,
	"provider" text NOT NULL,
	"image_url" text NOT NULL,
	"status" text DEFAULT 'generated' NOT NULL,
	"cost_chf" double precision DEFAULT 0 NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"severity" text DEFAULT 'info' NOT NULL,
	"href" text,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"stage" text NOT NULL,
	"status" text NOT NULL,
	"trigger" text NOT NULL,
	"summary" text,
	"logs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "keywords" (
	"id" serial PRIMARY KEY NOT NULL,
	"phrase" text NOT NULL,
	"niche" text NOT NULL,
	"source" text NOT NULL,
	"demand_score" double precision DEFAULT 0 NOT NULL,
	"competition_score" double precision DEFAULT 0 NOT NULL,
	"seasonality_score" double precision DEFAULT 0 NOT NULL,
	"trend_score" double precision,
	"score" double precision DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "keywords_phrase_unique" UNIQUE("phrase")
);
--> statement-breakpoint
CREATE TABLE "listings" (
	"id" serial PRIMARY KEY NOT NULL,
	"design_id" integer,
	"keyword_id" integer,
	"niche" text NOT NULL,
	"product_type" text NOT NULL,
	"pod_provider" text,
	"title" text NOT NULL,
	"tags" jsonb NOT NULL,
	"description" text NOT NULL,
	"image_url" text NOT NULL,
	"price_chf" double precision NOT NULL,
	"pod_cost_chf" double precision DEFAULT 0 NOT NULL,
	"net_chf" double precision NOT NULL,
	"margin_pct" double precision NOT NULL,
	"validation" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'pending_approval' NOT NULL,
	"rejected_reason" text,
	"etsy_listing_id" text,
	"printify_product_id" text,
	"publish_mode" text,
	"publish_error" text,
	"views" integer DEFAULT 0 NOT NULL,
	"favorites" integer DEFAULT 0 NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_at" timestamp with time zone,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"etsy_receipt_id" text NOT NULL,
	"listing_id" integer,
	"buyer_country" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"total_chf" double precision NOT NULL,
	"fees_chf" double precision NOT NULL,
	"pod_cost_chf" double precision DEFAULT 0 NOT NULL,
	"offsite_ads_chf" double precision DEFAULT 0 NOT NULL,
	"profit_chf" double precision NOT NULL,
	"fulfillment_status" text NOT NULL,
	"pod_order_id" text,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_etsy_receipt_id_unique" UNIQUE("etsy_receipt_id")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "designs" ADD CONSTRAINT "designs_keyword_id_keywords_id_fk" FOREIGN KEY ("keyword_id") REFERENCES "public"."keywords"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_design_id_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."designs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_keyword_id_keywords_id_fk" FOREIGN KEY ("keyword_id") REFERENCES "public"."keywords"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;