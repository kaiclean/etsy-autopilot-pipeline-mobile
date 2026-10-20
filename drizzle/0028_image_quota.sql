-- Atomic per-day image-generation counters (row-locked upsert). Shared by daily runs and redesigns. Additive.
CREATE TABLE IF NOT EXISTS "image_quota" (
  "key" text PRIMARY KEY NOT NULL,
  "used" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
