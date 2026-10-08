import { config } from "@/lib/config";
import { HiggsfieldImageProvider } from "./higgsfield";
import { MockImageProvider } from "./mock";
import { OpenAIImageProvider } from "./openai";
import { ReplicateImageProvider } from "./replicate";
import type { ImageProvider } from "./types";

let providerOverride: ImageProvider | null = null;

/** Test hook. Production callers leave this unset. */
export function setImageProviderForTests(provider: ImageProvider | null) {
  providerOverride = provider;
}

/**
 * Mock artwork is only for demo shops. A live shop with IMAGE_PROVIDER unset throws
 * instead of queueing a flat placeholder.
 */
export function getImageProvider(opts?: { demo?: boolean }): ImageProvider {
  if (providerOverride) return providerOverride;
  switch (config.imageProvider) {
    case "higgsfield":
      return new HiggsfieldImageProvider();
    case "openai":
      return new OpenAIImageProvider();
    case "replicate":
      return new ReplicateImageProvider();
    default:
      if (opts?.demo) return new MockImageProvider();
      throw new Error("IMAGE_PROVIDER must be openai, replicate, or higgsfield. Mock artwork is only used in demo mode.");
  }
}

export type { ImageProvider, ImageRequest, GeneratedImage } from "./types";
