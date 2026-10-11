CREATE TABLE IF NOT EXISTS hot_signals (
  id serial PRIMARY KEY,
  shop_id uuid REFERENCES shops(id),
  provider text NOT NULL,
  category text,
  title text NOT NULL,
  phrase text NOT NULL,
  niche text,
  rank integer,
  badge text,
  label_text text,
  metric double precision,
  score double precision,
  source_url text NOT NULL,
  fetched_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS hot_signals_fetched_idx ON hot_signals (fetched_at DESC);
--> statement-breakpoint
-- timestamptz::date depends on the session timezone and is not immutable.
CREATE UNIQUE INDEX IF NOT EXISTS hot_signals_dedupe
  ON hot_signals (provider, source_url, ((fetched_at AT TIME ZONE 'UTC')::date));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS hot_signal_fetches (
  provider text PRIMARY KEY,
  fetched_at timestamptz NOT NULL
);
