CREATE TABLE "etsy_financial_evidence" (
  "id" serial PRIMARY KEY NOT NULL,
  "shop_id" uuid NOT NULL REFERENCES "shops"("id"),
  "etsy_shop_id" text NOT NULL,
  "listing_id" integer REFERENCES "listings"("id"),
  "etsy_listing_id" text,
  "receipt_id" text,
  "source_kind" text NOT NULL,
  "source_ref" text NOT NULL,
  "observation_ref" text NOT NULL,
  "ledger_type" text NOT NULL,
  "component" text NOT NULL,
  "status" text NOT NULL,
  "amount" text,
  "divisor" integer NOT NULL,
  "currency" text NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL,
  "content_hash" text NOT NULL,
  "imported_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "etsy_finance_source_observation" UNIQUE("shop_id", "source_kind", "source_ref", "observation_ref"),
  CONSTRAINT "etsy_finance_positive_divisor" CHECK ("divisor" > 0),
  CONSTRAINT "etsy_finance_currency" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "etsy_finance_source_kind" CHECK ("source_kind" IN ('seller_export', 'normalized_ledger')),
  CONSTRAINT "etsy_finance_component" CHECK ("component" IN ('revenue', 'fee', 'refund', 'tax', 'supplier_spend', 'adjustment', 'unknown')),
  CONSTRAINT "etsy_finance_status_amount" CHECK (
    ("status" = 'unavailable' AND "amount" IS NULL) OR
    ("status" IN ('actual', 'estimated') AND "amount" IS NOT NULL AND "amount" ~ '^-?(0|[1-9][0-9]{0,29})$')
  )
);
--> statement-breakpoint
CREATE INDEX "etsy_finance_shop_date" ON "etsy_financial_evidence" ("shop_id", "occurred_at");
