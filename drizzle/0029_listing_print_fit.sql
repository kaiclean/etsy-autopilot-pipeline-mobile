-- Apparel print fit: "fill" (art covers the print area) or "fitted" (4:5 master inside transparent margins). Additive.
ALTER TABLE "listings" ADD COLUMN IF NOT EXISTS "print_fit" text;
