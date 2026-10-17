ALTER TABLE designs
  ADD COLUMN IF NOT EXISTS source_image_url text,
  ADD COLUMN IF NOT EXISTS source_px jsonb,
  ADD COLUMN IF NOT EXISTS output_px jsonb,
  ADD COLUMN IF NOT EXISTS upscale_method text,
  ADD COLUMN IF NOT EXISTS print_target jsonb;
