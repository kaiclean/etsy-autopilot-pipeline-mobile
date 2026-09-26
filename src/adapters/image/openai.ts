import { config } from "@/lib/config";
import type { GeneratedImage, ImageProvider, ImageRequest } from "./types";

/** OpenAI Images API. Returns a data URL; move to Blob/S3 storage before scaling up. */
export class OpenAIImageProvider implements ImageProvider {
  readonly name = "openai";
  readonly estimatedCostChf = 0.05;

  async generate(req: ImageRequest): Promise<GeneratedImage> {
    const key = config.openaiKey;
    if (!key) throw new Error("OPENAI_API_KEY missing");
    const size = req.aspectRatio === "1:1" ? "1024x1024" : req.aspectRatio === "16:9" ? "1536x1024" : "1024x1536";
    const res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-1", prompt: req.prompt, size, n: 1 }),
    });
    if (!res.ok) throw new Error(`OpenAI images ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = await res.json();
    const item = json.data?.[0];
    const url = item?.url ?? (item?.b64_json ? `data:image/png;base64,${item.b64_json}` : undefined);
    if (!url) throw new Error("OpenAI returned no image");
    return { url, costChf: this.estimatedCostChf, provider: this.name };
  }
}
