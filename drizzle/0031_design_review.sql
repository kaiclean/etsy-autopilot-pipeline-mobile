-- Design sign-off after a redesign/upscale: pending | approved | rejected. Approval is blocked until approved. Additive.
ALTER TABLE "designs" ADD COLUMN IF NOT EXISTS "design_review" jsonb;
