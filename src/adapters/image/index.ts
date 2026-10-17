import { config } from "@/lib/config";
import { CloudflareImageProvider } from "./cloudflare";
import { imageErrorDetail } from "./errors";
import { HiggsfieldImageProvider } from "./higgsfield";
import { MockImageProvider } from "./mock";
import { OpenAIImageProvider } from "./openai";
import { ReplicateImageProvider } from "./replicate";
import { RunPodImageProvider } from "./runpod";
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
export function getImageProvider(opts?: { demo?: boolean; log?: (message: string, level: "warn") => void }): ImageProvider {
  if (providerOverride) return providerOverride;
  const primary = createProvider(config.imageProvider, opts?.demo);
  const fallbackName = config.imageFallbackProvider;
  if (!fallbackName || fallbackName === primary.name || primary.name === "mock") return primary;
  if (fallbackName === "mock") throw new Error("IMAGE_FALLBACK_PROVIDER must be a real image provider, not mock");
  const fallback = createProvider(fallbackName);
  return {
    name: primary.name,
    estimatedCostChf: primary.estimatedCostChf + fallback.estimatedCostChf,
    async generate(req) {
      try {
        return await primary.generate(req);
      } catch (error) {
        const detail = imageErrorDetail(error instanceof Error ? error.message : String(error));
        const message = `Image provider ${primary.name} failed: ${detail}; trying fallback ${fallback.name}`;
        console.warn(message);
        opts?.log?.(message, "warn");
        try {
          const image = await fallback.generate(req);
          // A failed request may still have incurred a provider charge.
          return { ...image, costChf: image.costChf + primary.estimatedCostChf };
        } catch (fallbackError) {
          throw new Error(`${primary.name} failed: ${detail}; fallback ${fallback.name} failed: ${imageErrorDetail(fallbackError instanceof Error ? fallbackError.message : String(fallbackError))}`);
        }
      }
    },
  };
}

function createProvider(name: string, demo?: boolean): ImageProvider {
  switch (name) {
    case "cloudflare":
      return new CloudflareImageProvider();
    case "higgsfield":
      return new HiggsfieldImageProvider();
    case "openai":
      return new OpenAIImageProvider();
    case "omniroute": {
      const route = config.omniroute;
      return new OpenAIImageProvider({
        name: "omniroute",
        apiKey: route.apiKey,
        baseUrl: route.baseUrl,
        model: route.imageModel,
        missingKey: "OMNIROUTE_API_KEY missing",
        openRouter: false,
      });
    }
    case "replicate":
      return new ReplicateImageProvider();
    case "runpod":
      return new RunPodImageProvider();
    default:
      if (name === "mock" && demo) return new MockImageProvider();
      throw new Error("IMAGE_PROVIDER / IMAGE_FALLBACK_PROVIDER must be openai, replicate, higgsfield, omniroute, runpod, or cloudflare. Mock artwork is only used in demo mode.");
  }
}

export type { ImageProvider, ImageRequest, GeneratedImage } from "./types";
