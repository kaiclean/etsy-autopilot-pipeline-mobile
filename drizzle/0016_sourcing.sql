CREATE TABLE IF NOT EXISTS supplier_quotes (
  id serial PRIMARY KEY,
  supplier text NOT NULL,
  preset text NOT NULL,
  region text NOT NULL,
  destination_country text,
  provider_ref text,
  in_stock boolean,
  base_cost_usd double precision,
  shipping_usd double precision,
  production_days integer,
  currency text,
  source_url text,
  fetched_at timestamptz NOT NULL
);
ALTER TABLE supplier_quotes ADD COLUMN IF NOT EXISTS destination_country text;
CREATE INDEX IF NOT EXISTS supplier_quotes_lookup ON supplier_quotes (preset, region, fetched_at DESC);
CREATE TABLE IF NOT EXISTS sourcing_choices (
  id serial PRIMARY KEY,
  preset text NOT NULL,
  region text NOT NULL,
  supplier text NOT NULL,
  provider_ref text,
  landed_cost_chf double precision,
  quote_id integer REFERENCES supplier_quotes(id),
  reason text,
  chosen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (preset, region)
);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sourcing_recheck jsonb;
