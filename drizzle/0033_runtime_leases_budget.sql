CREATE TABLE IF NOT EXISTS runtime_stage_leases (
  shop_id uuid NOT NULL REFERENCES shops(id), stage text NOT NULL,
  owner uuid NOT NULL, expires_at timestamptz NOT NULL,
  PRIMARY KEY (shop_id, stage)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS runtime_ai_budget_mutex (id integer PRIMARY KEY);
--> statement-breakpoint
INSERT INTO runtime_ai_budget_mutex(id) VALUES (1) ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS runtime_ai_reservations (
  id uuid PRIMARY KEY, shop_id uuid NOT NULL REFERENCES shops(id),
  estimated_cost_chf double precision NOT NULL CHECK (estimated_cost_chf >= 0),
  recorded_cost_chf double precision NOT NULL DEFAULT 0 CHECK (recorded_cost_chf >= 0),
  neurons integer NOT NULL DEFAULT 0 CHECK (neurons >= 0),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','settled','uncertain','released')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS runtime_ai_reservations_shop_date_idx ON runtime_ai_reservations(shop_id,created_at);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reserve_runtime_ai_budget(
  p_id uuid, p_shop uuid, p_cost double precision, p_neurons integer,
  p_daily double precision, p_monthly double precision, p_now timestamptz
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE day_start timestamptz; month_start timestamptz; day_total double precision; month_total double precision; neuron_total bigint;
BEGIN
  -- A transaction-scoped row lock works over Neon HTTP. Each SELECT after the
  -- lock sees the latest committed snapshot, including the previous reservation.
  PERFORM id FROM runtime_ai_budget_mutex WHERE id=1 FOR UPDATE;
  day_start := date_trunc('day', p_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  month_start := date_trunc('month', p_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  SELECT
    coalesce((SELECT sum(amount_chf) FROM costs WHERE shop_id=p_shop AND created_at>=day_start AND kind IN ('ai_image','ai_text')),0)
      + coalesce((SELECT sum(greatest(estimated_cost_chf-recorded_cost_chf,0)) FROM runtime_ai_reservations WHERE shop_id=p_shop AND created_at>=day_start AND state IN ('pending','uncertain')),0),
    coalesce((SELECT sum(amount_chf) FROM costs WHERE shop_id=p_shop AND created_at>=month_start AND kind IN ('ai_image','ai_text')),0)
      + coalesce((SELECT sum(greatest(estimated_cost_chf-recorded_cost_chf,0)) FROM runtime_ai_reservations WHERE shop_id=p_shop AND created_at>=month_start AND state IN ('pending','uncertain')),0),
    coalesce((SELECT sum(neurons) FROM runtime_ai_reservations WHERE created_at>=day_start AND state<>'released'),0)
      + coalesce((SELECT sum(substring(note from '^Workers AI neurons: ([0-9]+)')::bigint) FROM costs WHERE created_at>=day_start AND kind='ai_image' AND note LIKE 'Workers AI neurons:%'),0)
  INTO day_total,month_total,neuron_total;
  IF day_total+p_cost>p_daily OR month_total+p_cost>p_monthly OR neuron_total+p_neurons>10000 THEN RETURN NULL; END IF;
  INSERT INTO runtime_ai_reservations(id,shop_id,estimated_cost_chf,neurons,created_at,updated_at)
    VALUES(p_id,p_shop,p_cost,p_neurons,p_now,p_now);
  RETURN p_id;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS publish_dead_letters (
  id serial PRIMARY KEY, shop_id uuid NOT NULL DEFAULT current_omnishop_id() REFERENCES shops(id),
  listing_id integer REFERENCES listings(id), stage text NOT NULL, error text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0, last_attempt_at timestamptz,
  resolved boolean NOT NULL DEFAULT false, resolved_at timestamptz, resolved_by text, resolution text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS publish_dead_letters_listing_idx ON publish_dead_letters(listing_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS publish_dead_letters_shop_idx ON publish_dead_letters(shop_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS publish_dead_letters_unresolved_idx ON publish_dead_letters(listing_id) WHERE resolved=false;
