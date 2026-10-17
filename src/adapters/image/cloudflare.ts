import { config } from "@/lib/config";
import { withStoredUrl } from "@/lib/object-storage";
import { ImageProviderHttpError, imageErrorDetail } from "./errors";
import type { GeneratedImage, ImageProvider, ImageRequest } from "./types";

export const CLOUDFLARE_IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";

export class CloudflareImageProvider implements ImageProvider {
  readonly name = "cloudflare";
  readonly estimatedCostChf = 0;

  async generate(req: ImageRequest): Promise<GeneratedImage> {
    const { accountId, apiToken } = config.cloudflare;
    if (!accountId) throw new Error("CLOUDFLARE_ACCOUNT_ID missing");
    if (!apiToken) throw new Error("CLOUDFLARE_API_TOKEN missing");
    const signal = AbortSignal.timeout(30_000);
    try {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${CLOUDFLARE_IMAGE_MODEL}`,
        {
          method: "POST",
          headers: { Authorization: "Bearer " + apiToken, "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: req.prompt, steps: 4 }),
          signal,
        },
      );
      if (!response.ok) throw new ImageProviderHttpError("Cloudflare", response.status, await response.text());
      const body = await response.json() as { success?: boolean; result?: { image?: string }; errors?: unknown };
      if (body.success === false) throw new Error(`Cloudflare image generation failed: ${imageErrorDetail(JSON.stringify(body.errors ?? []))}`);
      const image = body.result?.image;
      if (typeof image !== "string" || !image || !/^[A-Za-z0-9+/]+={0,2}$/.test(image)) {
        throw new Error("Cloudflare completed without a base64 output image");
      }
      return withStoredUrl({ url: `data:image/jpeg;base64,${image}`, costChf: 0, provider: this.name });
    } catch (error) {
      if (signal.aborted) throw new Error("Cloudflare image request timed out after 30 seconds");
      throw error;
    }
  }
}
