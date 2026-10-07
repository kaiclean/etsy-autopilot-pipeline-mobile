CREATE TABLE "promotions" (
	"id" serial PRIMARY KEY NOT NULL,
	"listing_id" integer NOT NULL,
	"channel" text DEFAULT 'pinterest' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"mode" text NOT NULL,
	"pin_id" text,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promotions_listing_id_unique" UNIQUE("listing_id")
);
--> statement-breakpoint
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;