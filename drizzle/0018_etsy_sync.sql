CREATE TABLE IF NOT EXISTS etsy_sync_state (
  shop_id uuid PRIMARY KEY REFERENCES shops(id),
  receipts_through timestamptz,
  refresh_lease_owner uuid,
  refresh_lease_until timestamptz
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS etsy_receipt_snapshots (
  shop_id uuid NOT NULL REFERENCES shops(id),
  receipt_line_id text NOT NULL,
  etsy_listing_id text NOT NULL,
  paid boolean NOT NULL,
  canceled boolean NOT NULL,
  refund_detected boolean NOT NULL,
  quantity integer NOT NULL,
  original_money jsonb,
  fx_rate double precision,
  fx_as_of timestamptz,
  source_modified_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, receipt_line_id)
);
--> statement-breakpoint
ALTER TABLE orders ADD COLUMN IF NOT EXISTS etsy_payment_status text NOT NULL DEFAULT 'paid';
