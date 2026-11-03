import { assertPaidInferenceAllowed } from "@/lib/free-mode";
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

const GPT_IMAGE_2 = /^gpt-image-(?:2(?:\\.5-(?:flare|sunburst))?)(?:-|$)/;

/**
 * GPT Image 2/2.5 accepts exact product-shaped canvases in 16px steps.
 * Older OpenAI-compatible endpoints only support the three standard sizes.
 * Reject invalid/out-of-policy sizes instead of sending a billable bad request.
 */
export function generationCanvasSize(req: Pick<ImageRequest, "aspectRatio" | "width" | "height">, model: string): string {
  const aspect = req.aspectRatio ?? "2:3";
  const legacy = aspect === "1:1" ? "1024x1024" : aspect === "16:9" ? "1536x1024" : "1024x1536";
  if (!GPT_IMAGE_2.test(model) || !Number.isFinite(req.width) || !Number.isFinite(req.height)) return legacy;
  const width = Math.round(Number(req.width) / 16) * 16;
  const height = Math.round(Number(req.height) / 16) * 16;
  if (width < 16 || height < 16 || width > 3840 || height > 3840 ||
    Math.max(width / height, height / width) > 3 ||
    width * height < 655_360 || width * height > 8_294_400) return legacy;
  return `${width}x${height}`;
}

/**
 * Images API usage on GPT Image 2.5: $5/1M text-input tokens and $30/1M image-output
 * tokens. No image inputs are sent by this generation endpoint. The caller already
 * accounts approximately USD≈CHF; operator-defined caps remain the authoritative gate.
 */
export function imageUsageCostUsd(usage: { cost?: number; input_tokens?: number; output_tokens?: number } | undefined, model: string): number | undefined {
  if (typeof usage?.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0) return usage.cost;
  if (model.startsWith("gpt-image-2.5-") &&
    typeof usage?.output_tokens === "number" && Number.isFinite(usage.output_tokens) && usage.output_tokens >= 0) {
    const textTokens = typeof usage.input_tokens === "number" && Number.isFinite(usage.input_tokens)
      ? Math.max(0, usage.input_tokens) : 0;
    return (textTokens * 5 + usage.output_tokens * 30) / 1_000_000;
  }
  return undefined;
}

/** OpenAI-compatible Images API. Bytes are uploaded to object storage when S3 or Blob is configured. */
export class OpenAIImageProvider implements ImageProvider {
  readonly name: string;
  private readonly options?: CompatibleImageOptions;

  /** Reserve conservatively before calls; configurable for changing model output costs. */
  get estimatedCostChf(): number {
    const base = (this.options?.baseUrl ?? config.imageBaseUrl).replace(/\\/$/, "");
    const model = this.options?.model ?? config.imageModel;
    if (base === "https://api.openai.com/v1" && model.startsWith("gpt-image-2")) {
      const configured = Number(process.env.OPENAI_IMAGE_ESTIMATED_COST_CHF ?? "0.50");
      return Number.isFinite(configured) && configured >= 0.05 ? configured : 0.50;
    }
    return 0.05;
  }

  constructor(options?: CompatibleImageOptions) {
    this.name = options?.name ?? "openai";
    this.options = options;
  }

  async generate(req: ImageRequest): Promise<GeneratedImage> {
    assertPaidInferenceAllowed("openai-compatible image");
    const defaults = !this.options;
    const key = defaults ? config.imageApiKey : this.options?.apiKey;
    if (!key) throw new Error(this.options?.missingKey ?? "IMAGE_API_KEY or OPENAI_API_KEY missing");
    const base = (defaults ? config.imageBaseUrl : (this.options?.baseUrl ?? "")).replace(/\\/$/, "");
    if (!base) throw new Error(this.name === "omniroute" ? "OMNIROUTE_BASE_URL missing" : "IMAGE_BASE_URL missing");
    const model = defaults ? config.imageModel : this.options?.model;
    if (!model) throw new Error(this.name === "omniroute" ? "OMNIROUTE_IMAGE_MODEL missing" : "IMAGE_MODEL missing");
    const isOpenRouter = this.options?.openRouter ?? /openrouter\\.ai/i.test(base);
    const nativeOpenAi = base === "https://api.openai.com/v1" && /^gpt-image-/.test(model);
    const body: Record<string, unknown> = {
      model,
      prompt: req.prompt,
      n: 1,
      size: generationCanvasSize(req, model),
    };
    if (isOpenRouter) body.aspect_ratio = req.aspectRatio ?? "2:3";
    if (nativeOpenAi) {
      body.quality = config.openaiImageQuality;
      body.background = "opaque";
      body.output_format = "png";
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    };
    if (isOpenRouter) {
      headers["HTTP-Referer"] = process.env.APP_URL || "http://localhost:4317";
      headers["X-Title"] = "DesignedByKaiArt";
    }

    // OpenRouter's alternate path is only a fallback when the endpoint is absent, never
    // a second billable attempt after rate limits, provider errors or insufficient credits.
    const paths = isOpenRouter ? ["/images", "/images/generations"] : ["/images/generations"];
    let lastErr = "";
    for (const path of paths) {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
      });
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 300);
        lastErr = `${path} ${res.status}: ${detail}`;
        if (res.status === 402 || isProviderCreditsError(detail) || ![404, 405].includes(res.status)) break;
        continue;
      }
      const json = (await res.json()) as {
        data?: Array<{ url?: string; b64_json?: string; media_type?: string }>;
        usage?: { cost?: number; input_tokens?: number; output_tokens?: number };
      };
      const item = json.data?.[0];
      const mime = item?.media_type ?? "image/png";
      const url = item?.url ?? (item?.b64_json ? `data:${mime};base64,${item.b64_json}` : undefined);
      if (!url) throw new Error(`OpenAI images failed: ${path}: no image in response`);
      const costUsd = imageUsageCostUsd(json.usage, model);
      const costChf = costUsd != null ? Math.max(costUsd, 0.01) : this.estimatedCostChf;
      return withStoredUrl({ url, costChf, provider: this.name });
    }
    throw new Error(`OpenAI images failed: ${lastErr || "unknown"}`);
  }
}
