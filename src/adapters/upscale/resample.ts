import type { Enlarged, Upscaler } from "./types";

/** No model: the print renderer enlarges with Lanczos resampling. Free, but adds no detail. */
export class ResampleUpscaler implements Upscaler {
  readonly name = "resample";
  readonly estimatedCostChf = 0;

  async enlarge(src: Buffer): Promise<Enlarged> {
    return { bytes: src, costChf: 0, method: "resample" };
  }
}
