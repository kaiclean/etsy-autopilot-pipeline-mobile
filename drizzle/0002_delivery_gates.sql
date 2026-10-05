CREATE TABLE "pod_samples" (
	"id" serial PRIMARY KEY NOT NULL,
	"blueprint_id" integer NOT NULL,
	"provider_id" integer NOT NULL,
	"note" text,
	"approved_at" timestamp with time zone NOT NULL,
	"approved_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pod_samples_blueprint_provider" UNIQUE("blueprint_id","provider_id")
);
--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "delivery_url" text;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "file_manifest" jsonb;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "file_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "file_verified_by" text;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "activated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "pod_blueprint_id" integer;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "pod_print_provider_id" integer;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "pod_published_at" timestamp with time zone;