export type Enlarged = {
  bytes: Buffer;
  costChf: number;
  /** "upscale" when a model added detail; "resample" when the renderer only interpolates. */
  method: "resample" | "upscale";
};

export interface Upscaler {
  readonly name: string;
  /** Upper bound per image, checked against the AI spend caps before calling. */
  readonly estimatedCostChf: number;
  /** `factor` is the largest enlargement any print size needs from `src`. */
  enlarge(src: Buffer, factor: number): Promise<Enlarged>;
}
