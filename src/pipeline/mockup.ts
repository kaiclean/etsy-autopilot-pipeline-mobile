import type { Niche, ProductType } from "@/db/schema";
import { isPlaceholderUrl } from "@/lib/art-quality";
import { config } from "@/lib/config";
import type { PodPreset } from "@/lib/fees";
import { digitalPreviewUrl } from "@/lib/png";

export type MockupRequest = {
  artworkUrl: string;
  preset: PodPreset;
  niche: Niche | string;
  /** Set after a Printify product exists. Draft listings omit this and use the template. */
  productId?: string;
};

export type MockupResult = {
  url: string;
  provider: string;
  /** False when the URL is the raw artwork. Digital galleries use a preview instead. */
  mocked: boolean;
};

/**
 * Pluggable POD mockup step. The first provider that returns an image wins.
 * Printify mockups exist only after a product is created; the template compositor
 * is the default so wall art and mugs are never listed as raw artwork.
 */
export interface MockupProvider {
  readonly name: string;
  tryCompose(req: MockupRequest): Promise<MockupResult | null>;
}

export function podMockupUrl(preset: PodPreset, niche: string, artworkUrl?: string) {
  const params = new URLSearchParams({ niche });
  if (artworkUrl && !isPlaceholderUrl(artworkUrl) && artworkUrl.length <= 1800 && !artworkUrl.startsWith("data:")) {
    params.set("src", artworkUrl);
  }
  return `/api/mockup/${preset}?${params.toString()}`;
}

/** PNG product scene (frame, mug, tee). Served by `/api/mockup/[preset]`, which composites `src` when it is real art. */
export const templateMockupProvider: MockupProvider = {
  name: "template-mockup",
  async tryCompose(req) {
    return { url: podMockupUrl(req.preset, req.niche, req.artworkUrl), provider: this.name, mocked: true };
  },
};

type PrintifyImage = { src?: string; position?: string };

/** Printify's generated product images, when a product id and API token are available. */
export async function fetchPrintifyMockupUrl(productId: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const { token, shopId } = config.printify;
  if (!token || !shopId || !productId || productId.startsWith("dry-")) return null;
  try {
    const res = await fetchImpl(`https://api.printify.com/v1/shops/${shopId}/products/${productId}.json`, {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "EtsyAutopilot" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { images?: PrintifyImage[] };
    const images = (body.images ?? []).filter((img) => img.src);
    const lifestyle = images.find((img) => /mockup|lifestyle|camera/i.test(`${img.position ?? ""} ${img.src}`));
    return (lifestyle ?? images[0])?.src ?? null;
  } catch {
    return null;
  }
}

export const printifyMockupProvider: MockupProvider = {
  name: "printify-mockup",
  async tryCompose(req) {
    if (!req.productId) return null;
    const url = await fetchPrintifyMockupUrl(req.productId);
    if (!url) return null;
    return { url, provider: this.name, mocked: true };
  },
};

const PROVIDERS: MockupProvider[] = [printifyMockupProvider, templateMockupProvider];

export async function listingImageForProduct(opts: {
  productType: ProductType;
  artworkUrl: string;
  preset?: PodPreset;
  niche: Niche | string;
  productId?: string;
}): Promise<MockupResult> {
  if (opts.productType !== "pod" || !opts.preset) {
    return { url: digitalPreviewUrl(opts.artworkUrl, String(opts.niche)), provider: "preview", mocked: true };
  }
  const req: MockupRequest = {
    artworkUrl: opts.artworkUrl,
    preset: opts.preset,
    niche: opts.niche,
    productId: opts.productId,
  };
  for (const provider of PROVIDERS) {
    try {
      const image = await provider.tryCompose(req);
      if (image) return image;
    } catch {
      // The template provider is last and does not throw; a failed live hook falls through.
    }
  }
  return { url: podMockupUrl(opts.preset, opts.niche), provider: "template-mockup", mocked: true };
}

/** Print file for Printify. The listing image may be a mockup; the design file is what gets printed. */
export function printArtworkUrl(listingImageUrl: string, designImageUrl?: string | null) {
  return designImageUrl || listingImageUrl;
}
