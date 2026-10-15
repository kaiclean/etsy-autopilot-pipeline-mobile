CREATE TABLE IF NOT EXISTS "etsy_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "delivery_key" text NOT NULL,
  "source" text NOT NULL DEFAULT 'webhook' CHECK ("source" IN ('webhook', 'operator')),
  "shop_id" uuid NOT NULL REFERENCES "shops"("id"),
  "etsy_shop_id" text NOT NULL,
  "event_type" text NOT NULL,
  "resource_type" text NOT NULL CHECK ("resource_type" IN ('listing', 'receipt')),
  "resource_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'processing', 'completed', 'dead_letter')),
  "queue_id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "dispatched_at" timestamptz,
  "attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "lease_until" timestamptz,
  "claim_token" uuid,
  "error_code" text,
  "received_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "etsy_events_delivery_key_unique" ON "etsy_events" ("delivery_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "etsy_events_recovery_idx" ON "etsy_events" ("status", "next_attempt_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "etsy_listing_observations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "shop_id" uuid NOT NULL REFERENCES "shops"("id"),
  "etsy_listing_id" text NOT NULL,
  "state" text,
  "quantity" integer,
  "remote_updated_at" timestamptz,
  "observed_at" timestamptz,
  "fetch_token" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "etsy_listing_observations_shop_listing_unique"
  ON "etsy_listing_observations" ("shop_id", "etsy_listing_id");
