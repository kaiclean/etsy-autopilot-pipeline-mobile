CREATE TABLE IF NOT EXISTS "box_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "shop_id" uuid NOT NULL REFERENCES "shops"("id"),
  "stage" text NOT NULL CHECK ("stage" IN ('all','hot','research','design','listing','publish','orders','analytics','maintenance','daily','health')),
  "trigger" text NOT NULL CHECK ("trigger" IN ('manual','cron')),
  "force" boolean NOT NULL DEFAULT false,
  "session_id" integer REFERENCES "brain_sessions"("id"),
  "idempotency_key" text NOT NULL,
  "status" text NOT NULL DEFAULT 'queued' CHECK ("status" IN ('queued','running','succeeded','failed','held')),
  "owner" uuid,
  "attempts" integer NOT NULL DEFAULT 0 CHECK ("attempts" >= 0 AND "attempts" <= 3),
  "summary" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "started_at" timestamptz,
  "finished_at" timestamptz,
  "lease_until" timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "box_jobs_idempotency_idx" ON "box_jobs" ("shop_id", "idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "box_jobs_status_idx" ON "box_jobs" ("status", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "box_shop_leases" (
  "shop_id" uuid PRIMARY KEY REFERENCES "shops"("id"),
  "owner" uuid NOT NULL,
  "lease_until" timestamptz NOT NULL
);
