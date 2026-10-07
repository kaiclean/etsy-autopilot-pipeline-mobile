import { ReplicateUpscaler } from "./replicate";
import { ResampleUpscaler } from "./resample";
import type { Upscaler } from "./types";

/** UPSCALE_PROVIDER=replicate opts in to model upscaling; anything else resamples for free. */
export function getUpscaler(): Upscaler {
  return process.env.UPSCALE_PROVIDER === "replicate" ? new ReplicateUpscaler() : new ResampleUpscaler();
}

export type { Enlarged, Upscaler } from "./types";
