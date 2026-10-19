import type { Niche } from "@/db/schema";
import type { ArtworkProvenance } from "@/lib/artwork-provenance";

export type ImageRequest = {
  prompt: string;
  niche: Niche;
  seed: number;
  aspectRatio?: "2:3" | "1:1" | "4:5" | "16:9";
  width?: number;
  height?: number;
  label?: string;
  print?: boolean;
};

export type GeneratedImage = {
  url: string;
  costChf: number;
  provider: string;
  provenance?: ArtworkProvenance;
};

export interface ImageProvider {
  readonly name: string;
  /** Upper bound per image, used to enforce the daily AI spend cap before calling. */
  readonly estimatedCostChf: number;
  /** Conservative Workers AI neuron estimate. Absent for providers without neuron billing. */
  readonly estimatedNeuronsPerImage?: number;
  generate(req: ImageRequest): Promise<GeneratedImage>;
}
