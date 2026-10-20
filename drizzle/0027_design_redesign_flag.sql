-- Designs whose source a 4x Real-ESRGAN pass cannot bring to the print target; Design rebuilds them at full size. Additive.
ALTER TABLE "designs" ADD COLUMN IF NOT EXISTS "needs_redesign" jsonb;
