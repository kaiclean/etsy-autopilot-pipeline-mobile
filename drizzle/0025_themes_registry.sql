-- Theme registry, idea candidates and keywords.theme_id. Strictly additive and idempotent.
CREATE TABLE IF NOT EXISTS "themes" (
  "id" text PRIMARY KEY,
  "label" text NOT NULL,
  "base_niche" text NOT NULL,
  "status" text NOT NULL DEFAULT 'proposed',
  "style" text,
  "seeds" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "products" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "peak_months" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "blocker" text,
  "notes" text,
  "source" text NOT NULL DEFAULT 'manual',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "idea_candidates" (
  "id" serial PRIMARY KEY,
  "key" text NOT NULL UNIQUE,
  "title" text NOT NULL,
  "phrase" text NOT NULL,
  "theme_id" text,
  "niche" text,
  "product" text,
  "rationale" text NOT NULL,
  "source" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "keyword_id" integer REFERENCES "keywords"("id"),
  "design_brief_id" integer REFERENCES "design_briefs"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "decided_at" timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idea_candidates_status_idx" ON "idea_candidates" ("status", "created_at");
--> statement-breakpoint
ALTER TABLE "keywords" ADD COLUMN IF NOT EXISTS "theme_id" text;
