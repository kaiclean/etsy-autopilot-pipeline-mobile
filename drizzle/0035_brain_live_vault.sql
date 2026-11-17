CREATE TABLE IF NOT EXISTS "brain_vault_notes" (
  "id" text PRIMARY KEY NOT NULL,
  "markdown" text NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
