import { withStoredUrl } from "@/lib/object-storage";
import type { GeneratedImage, ImageProvider, ImageRequest } from "./types";

export class MockImageProvider implements ImageProvider {
  readonly name = "mock";
  readonly estimatedCostChf = 0;

  async generate(req: ImageRequest): Promise<GeneratedImage> {
    const params = new URLSearchParams({ niche: req.niche });
    if (req.label) params.set("label", req.label.slice(0, 40));
    return withStoredUrl({ url: `/api/placeholder/${req.seed}?${params}`, costChf: 0, provider: this.name });
  }
}
