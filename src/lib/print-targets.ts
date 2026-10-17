import type { PodPreset } from "./fees";

/** Minimum native artwork pixels, before cover cropping. Never enlarge a source to pass. */
export const PRINT_TARGETS: Record<PodPreset, { width: number; height: number }> = {
  posterA3: { width: 2480, height: 3508 },
  mug: { width: 2700, height: 1100 },
  tshirt: { width: 3600, height: 4800 },
  sweatshirt: { width: 3600, height: 4800 },
  tote: { width: 3000, height: 3000 },
  phoneCase: { width: 1200, height: 2400 },
  canvas: { width: 3600, height: 5400 },
  sticker: { width: 900, height: 900 },
  blanket: { width: 6000, height: 7200 },
  hoodie: { width: 3600, height: 4800 },
  ornament: { width: 900, height: 900 },
};
