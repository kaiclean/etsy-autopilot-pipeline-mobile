ALTER TABLE "listings" ADD COLUMN IF NOT EXISTS "pod_cost_note" text;
--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN IF NOT EXISTS "pod_variant_prices" jsonb;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "refunded_chf" double precision;
--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "refunded_chf" SET DEFAULT 0;
--> statement-breakpoint
UPDATE "orders" SET "refunded_chf" = 0 WHERE "refunded_chf" IS NULL;
--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "refunded_chf" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "profit_basis" text;
--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "profit_basis" SET DEFAULT 'estimated';
--> statement-breakpoint
UPDATE "orders" SET "profit_basis" = 'estimated' WHERE "profit_basis" IS NULL;
--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "profit_basis" SET NOT NULL;
