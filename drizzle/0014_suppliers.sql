ALTER TABLE listings ADD COLUMN IF NOT EXISTS supplier text;
--> statement-breakpoint
ALTER TABLE listings ADD COLUMN IF NOT EXISTS supplier_product_id text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS supplier_products (
  id serial PRIMARY KEY,
  supplier text NOT NULL,
  preset text NOT NULL,
  external_product_uid text NOT NULL,
  title text,
  base_cost_usd double precision,
  currency text,
  source_url text,
  fetched_at timestamptz NOT NULL,
  UNIQUE (supplier, preset, external_product_uid)
);
