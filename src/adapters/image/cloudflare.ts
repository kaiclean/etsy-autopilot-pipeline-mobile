import { config } from "@/lib/config";
import { withStoredUrl } from "@/lib/object-storage";
import { ImageProviderHttpError, imageErrorDetail } from "./errors";
import type { GeneratedImage, ImageProvider, ImageRequest } from "./types";

export const CLOUDFLARE_IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
export const CLOUDFLARE_PRINT_IMAGE_MODEL = "@cf/black-forest-labs/flux-2-klein-4b";

export function cloudflareModelInput(model: string, req: ImageRequest) {
  const useKlein = model === CLOUDFLARE_PRINT_IMAGE_MODEL;
  if (!useKlein) return { contentType: "application/json", body: JSON.stringify({ prompt: req.prompt, steps: 4 }) };
  const body = new FormData();
  body.set("prompt", req.prompt);
  const dimension = (value: number | undefined, fallback: number) =>
    Math.min(1920, Math.max(256, Math.round(Number.isFinite(value) ? value! : fallback)));
  body.set("width", String(dimension(req.width, 1280)));
  body.set("height", String(dimension(req.height, 1920)));
  return { contentType: undefined, body };
}

export class CloudflareImageProvider implements ImageProvider {
  readonly name = "cloudflare";
  readonly estimatedCostChf = 0;
  readonly estimatedNeuronsPerImage = 1000;

  async generate(req: ImageRequest): Promise<GeneratedImage> {
    const { accountId, apiToken } = config.cloudflare;
    // Print renders need the size-honouring model; flux-1-schnell ignores width/height and returns 1024×1024.
    const model = req.print ? CLOUDFLARE_PRINT_IMAGE_MODEL : config.cloudflare.imageModel;
    if (!/^@?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(model) || model.split("/").some((segment) => segment === "." || segment === "..")) {
      throw new Error("CLOUDFLARE_IMAGE_MODEL is invalid");
    }
    if (!accountId) throw new Error("CLOUDFLARE_ACCOUNT_ID missing");
    if (!apiToken) throw new Error("CLOUDFLARE_API_TOKEN missing");
    const signal = AbortSignal.timeout(30_000);
    try {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`,
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + apiToken,
            ...(model === CLOUDFLARE_PRINT_IMAGE_MODEL ? {} : { "Content-Type": "application/json" }),
          },
          body: cloudflareModelInput(model, req).body,
          signal,
        },
      );
      if (!response.ok) throw new ImageProviderHttpError("Cloudflare", response.status, await response.text());
      const contentType = response.headers?.get("content-type")?.split(";")[0]?.trim() ?? "";
      if (contentType.startsWith("image/") || contentType === "application/octet-stream") {
        const image = Buffer.from(await response.arrayBuffer());
        if (!image.length) throw new Error("Cloudflare completed without an image");
        const imageType = contentType === "application/octet-stream" ? "image/png" : contentType;
        return withStoredUrl({ url: `data:${imageType};base64,${image.toString("base64")}`, costChf: 0, provider: this.name });
      }
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
