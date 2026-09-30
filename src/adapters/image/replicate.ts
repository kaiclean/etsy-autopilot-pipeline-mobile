import { config } from "@/lib/config";
import { withStoredUrl } from "@/lib/object-storage";
import type { GeneratedImage, ImageProvider, ImageRequest } from "./types";

export class ReplicateImageProvider implements ImageProvider {
  readonly name = "replicate";
  readonly estimatedCostChf = 0.03;

  async generate(req: ImageRequest): Promise<GeneratedImage> {
    const token = config.replicateToken;
    if (!token) throw new Error("REPLICATE_API_TOKEN missing");
    const model = process.env.REPLICATE_MODEL ?? "black-forest-labs/flux-schnell";
    const res = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "wait=60" },
      body: JSON.stringify({ input: { prompt: req.prompt, aspect_ratio: req.aspectRatio ?? "2:3", seed: req.seed } }),
    });
    if (!res.ok) throw new Error(`Replicate ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = await res.json();
    const out = Array.isArray(json.output) ? json.output[0] : json.output;
    if (!out) throw new Error(`Replicate prediction not finished (status ${json.status})`);
    return withStoredUrl({ url: String(out), costChf: this.estimatedCostChf, provider: this.name });
  }
}
