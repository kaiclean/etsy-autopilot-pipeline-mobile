ALTER TABLE design_briefs ADD COLUMN IF NOT EXISTS brain_origin jsonb;
--> statement-breakpoint
ALTER TABLE idea_candidates ADD COLUMN IF NOT EXISTS brain_origin jsonb;
--> statement-breakpoint
ALTER TABLE box_jobs ADD COLUMN IF NOT EXISTS keyword_id integer REFERENCES keywords(id);

--> statement-breakpoint
ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS keyword_id integer REFERENCES keywords(id);
