-- Dashboard sessions (stage runs started from /brain/sessions) and the Kai task list. Strictly additive and idempotent.
CREATE TABLE IF NOT EXISTS "brain_sessions" (
  "id" serial PRIMARY KEY,
  "stage" text NOT NULL,
  "status" text NOT NULL DEFAULT 'queued',
  "job_run_id" integer,
  "summary" text,
  "retry_of" integer,
  "task_id" integer,
  "cancel_requested" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "started_at" timestamptz,
  "finished_at" timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brain_sessions_created_idx" ON "brain_sessions" ("created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "brain_tasks" (
  "id" serial PRIMARY KEY,
  "title" text NOT NULL,
  "notes" text,
  "stage" text NOT NULL DEFAULT 'research',
  "status" text NOT NULL DEFAULT 'todo',
  "last_session_id" integer,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brain_tasks_status_idx" ON "brain_tasks" ("status", "updated_at");
