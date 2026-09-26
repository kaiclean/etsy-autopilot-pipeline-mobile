import type { Niche } from "@/db/schema";

export type ImageRequest = {
  prompt: string;
  niche: Niche;
  seed: number;
  aspectRatio?: "2:3" | "1:1" | "4:5" | "16:9";
  label?: string;
};

export type GeneratedImage = {
  url: string;
  costChf: number;
  provider: string;
};

export interface ImageProvider {
  readonly name: string;
  /** Upper bound per image, used to enforce the daily AI spend cap before calling. */
  readonly estimatedCostChf: number;
  generate(req: ImageRequest): Promise<GeneratedImage>;
}
