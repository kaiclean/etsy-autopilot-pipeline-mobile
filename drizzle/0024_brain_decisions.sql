-- OmniGram Brain decisions. Strictly additive and idempotent: safe to re-run, touches no existing table data.
CREATE TABLE IF NOT EXISTS "brain_decisions" (
  "id" serial PRIMARY KEY,
  "idea_id" text NOT NULL,
  "verdict" text NOT NULL,
  "comment" text,
  "priority" integer,
  "phrase" text,
  "niche" text,
  "keyword_id" integer REFERENCES "keywords"("id"),
  "design_brief_id" integer REFERENCES "design_briefs"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brain_decisions_idea_idx" ON "brain_decisions" ("idea_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brain_decisions_created_idx" ON "brain_decisions" ("created_at");
