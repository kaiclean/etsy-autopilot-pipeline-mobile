CREATE TABLE IF NOT EXISTS marketplace_listings (
  id serial PRIMARY KEY,
  listing_id integer NOT NULL REFERENCES listings(id),
  marketplace text NOT NULL,
  external_id text,
  status text NOT NULL DEFAULT 'draft',
  payload_preview jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (listing_id, marketplace)
);
