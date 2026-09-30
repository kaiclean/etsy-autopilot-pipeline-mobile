import { config } from "@/lib/config";
import { withStoredUrl } from "@/lib/object-storage";
import type { GeneratedImage, ImageProvider, ImageRequest } from "./types";

/** OpenAI-compatible Images API (OpenAI or OpenRouter). Bytes are uploaded to object storage when S3 or Blob is configured. */
export class OpenAIImageProvider implements ImageProvider {
  readonly name = "openai";
  /** Soft pre-call estimate (CHF); OpenRouter gemini flash image is ~USD 0.04. */
  readonly estimatedCostChf = 0.05;

  async generate(req: ImageRequest): Promise<GeneratedImage> {
    const key = config.openaiKey;
    if (!key) throw new Error("OPENAI_API_KEY missing");
    const aspectRatio = req.aspectRatio ?? "2:3";
    const size =
      aspectRatio === "1:1" ? "1024x1024" : aspectRatio === "16:9" ? "1536x1024" : "1024x1536";
    const base = config.openaiBaseUrl;
    const model = config.openaiImageModel;
    const isOpenRouter = /openrouter\.ai/i.test(base);
    const body: Record<string, unknown> = {
      model,
      prompt: req.prompt,
      n: 1,
      size,
      aspect_ratio: aspectRatio,
    };

    const headers: Record<string, string> = {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    };
    if (isOpenRouter) {
      headers["HTTP-Referer"] = process.env.APP_URL || "http://localhost:4317";
      headers["X-Title"] = "DesignedByKaiArt";
    }

    // Prefer OpenRouter dedicated /images when on OpenRouter; fall back to /images/generations.
    const paths = isOpenRouter ? ["/images", "/images/generations"] : ["/images/generations"];
    let lastErr = "";
    for (const path of paths) {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        lastErr = `${path} ${res.status}: ${(await res.text()).slice(0, 300)}`;
        continue;
      }
      const json = (await res.json()) as {
        data?: Array<{ url?: string; b64_json?: string; media_type?: string }>;
        usage?: { cost?: number };
      };
      const item = json.data?.[0];
      const mime = item?.media_type ?? "image/png";
      const url =
        item?.url ?? (item?.b64_json ? `data:${mime};base64,${item.b64_json}` : undefined);
      if (!url) {
        lastErr = `${path}: no image in response`;
        continue;
      }
      const costUsd = typeof json.usage?.cost === "number" ? json.usage.cost : undefined;
      // Treat USD≈CHF for cap accounting when provider reports usage.cost.
      const costChf = costUsd != null ? Math.max(costUsd, 0.01) : this.estimatedCostChf;
      return withStoredUrl({ url, costChf, provider: this.name });
    }
    throw new Error(`OpenAI images failed: ${lastErr || "unknown"}`);
  }
}
