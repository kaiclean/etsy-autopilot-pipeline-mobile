import { config } from "@/lib/config";
import { HiggsfieldImageProvider } from "./higgsfield";
import { MockImageProvider } from "./mock";
import { OpenAIImageProvider } from "./openai";
import { ReplicateImageProvider } from "./replicate";
import type { ImageProvider } from "./types";

export function getImageProvider(): ImageProvider {
  switch (config.imageProvider) {
    case "higgsfield":
      return new HiggsfieldImageProvider();
    case "openai":
      return new OpenAIImageProvider();
    case "replicate":
      return new ReplicateImageProvider();
    default:
      return new MockImageProvider();
  }
}

export type { ImageProvider, ImageRequest, GeneratedImage } from "./types";
