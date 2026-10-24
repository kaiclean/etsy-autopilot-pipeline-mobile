CREATE TABLE IF NOT EXISTS operation_leases (
  key text PRIMARY KEY, owner text NOT NULL, expires_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS operation_attempts (
  key text PRIMARY KEY, status text NOT NULL DEFAULT 'running', result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS durable_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), dedupe_key text UNIQUE NOT NULL,
  shop_id uuid NOT NULL REFERENCES shops(id), kind text NOT NULL, payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued', attempts integer NOT NULL DEFAULT 0,
  owner text, lease_until timestamptz, result jsonb, error_code text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS durable_jobs_pending ON durable_jobs(status, next_attempt_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS upscale_failure_reports (
  report_id text PRIMARY KEY, design_id integer NOT NULL REFERENCES designs(id), created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ai_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), day text NOT NULL, month text NOT NULL,
  reserved_chf double precision NOT NULL, actual_chf double precision, created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS login_attempts (
  key text PRIMARY KEY, failures integer NOT NULL DEFAULT 0, window_start timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ai_budget_epoch (id integer PRIMARY KEY, started_at timestamptz NOT NULL DEFAULT now());
--> statement-breakpoint
INSERT INTO ai_budget_epoch (id) VALUES (1) ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS worker_heartbeats (key text PRIMARY KEY, seen_at timestamptz NOT NULL DEFAULT now());
--> statement-breakpoint
ALTER TABLE daily_stats ADD COLUMN IF NOT EXISTS shop_id uuid NOT NULL DEFAULT current_omnishop_id() REFERENCES shops(id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS daily_stats_shop_date ON daily_stats(shop_id,date);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS upscale_work_leases (design_id integer PRIMARY KEY REFERENCES designs(id), owner uuid NOT NULL, expires_at timestamptz NOT NULL);
--> statement-breakpoint
ALTER TABLE upscale_uploads ADD COLUMN IF NOT EXISTS source_url text;
--> statement-breakpoint
ALTER TABLE operation_attempts ADD COLUMN IF NOT EXISTS input jsonb;
