import { config } from "@/lib/config";
import { withStoredUrl } from "@/lib/object-storage";
import { isProviderCreditsError } from "@/lib/provider-errors";
import type { GeneratedImage, ImageProvider, ImageRequest } from "./types";

export type CompatibleImageOptions = {
  name?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  missingKey?: string;
  /** When omitted, OpenRouter hosts try /images and then /images/generations. */
  openRouter?: boolean;
};

/** OpenAI-compatible Images API. Bytes are uploaded to object storage when S3 or Blob is configured. */
export class OpenAIImageProvider implements ImageProvider {
  readonly name: string;
  /** Soft pre-call estimate (CHF); OpenRouter gemini flash image is ~USD 0.04. */
  readonly estimatedCostChf = 0.05;
  private readonly options?: CompatibleImageOptions;

  constructor(options?: CompatibleImageOptions) {
    this.name = options?.name ?? "openai";
    this.options = options;
  }

  async generate(req: ImageRequest): Promise<GeneratedImage> {
    const defaults = !this.options;
    const key = defaults ? config.imageApiKey : this.options?.apiKey;
    if (!key) throw new Error(this.options?.missingKey ?? "IMAGE_API_KEY or OPENAI_API_KEY missing");
    const aspectRatio = req.aspectRatio ?? "2:3";
    const size =
      aspectRatio === "1:1" ? "1024x1024" : aspectRatio === "16:9" ? "1536x1024" : "1024x1536";
    const base = (defaults ? config.imageBaseUrl : (this.options?.baseUrl ?? "")).replace(/\/$/, "");
    if (!base) throw new Error(this.name === "omniroute" ? "OMNIROUTE_BASE_URL missing" : "IMAGE_BASE_URL missing");
    const model = defaults ? config.imageModel : this.options?.model;
    if (!model) throw new Error(this.name === "omniroute" ? "OMNIROUTE_IMAGE_MODEL missing" : "IMAGE_MODEL missing");
    const isOpenRouter = this.options?.openRouter ?? /openrouter\.ai/i.test(base);
    const body: Record<string, unknown> = {
      model,
      prompt: req.prompt,
      n: 1,
      size,
    };
    if (isOpenRouter) body.aspect_ratio = aspectRatio;

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
        const text = (await res.text()).slice(0, 300);
        lastErr = `${path} ${res.status}: ${text}`;
        if (res.status === 402 || isProviderCreditsError(text)) break;
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
