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
  /** Only actual renderable views; never inferred pack files or unproduced lifestyle photography. */
  gallery?: ArtworkGalleryView[];
};

export type ArtworkGalleryView = {
  url: string;
  role: "artwork-preview" | "product-mockup";
  label: string;
  sourceDimensions?: { width: number; height: number };
};

type ListingImageOptions = {
  productType: ProductType;
  artworkUrl: string;
  preset?: PodPreset;
  niche: Niche | string;
  productId?: string;
  /** Measured source pixels, not advertised paper sizes or assumed print resolution. */
  sourceDimensions?: { width: number; height: number };
};

function withGallery(image: MockupResult, opts: ListingImageOptions): MockupResult {
  const measured = opts.sourceDimensions;
  const sourceDimensions = measured && Number.isSafeInteger(measured.width) && measured.width > 0 &&
    Number.isSafeInteger(measured.height) && measured.height > 0 ? measured : undefined;
  const primary: ArtworkGalleryView = {
    url: image.url,
    role: image.provider === "preview" ? "artwork-preview" : "product-mockup",
    label: image.provider === "preview" ? "Artwork preview; not the full-resolution delivery file" :
      image.provider === "printify-mockup" ? "Supplier-generated product mockup" :
        "Illustrative product preview; not a supplier placement proof",
    ...(sourceDimensions ? { sourceDimensions } : {}),
  };
  const gallery = [primary];
  if (opts.productType === "pod" && !isPlaceholderUrl(opts.artworkUrl)) {
    const preview = digitalPreviewUrl(opts.artworkUrl, String(opts.niche));
    if (new URL(preview, "http://localhost").searchParams.has("src") && preview !== image.url) {
      gallery.push({ url: preview, role: "artwork-preview", label: "Artwork composition preview; product mockup shown separately",
        ...(sourceDimensions ? { sourceDimensions } : {}) });
    }
  }
  return { ...image, gallery };
}

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

/** PNG scene for every POD preset. `/api/mockup/[preset]` composites `src` when it is real art. */
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

export async function listingImageForProduct(opts: ListingImageOptions): Promise<MockupResult> {
  if (opts.productType !== "pod" || !opts.preset) {
    return withGallery({ url: digitalPreviewUrl(opts.artworkUrl, String(opts.niche)), provider: "preview", mocked: true }, opts);
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
      if (image) return withGallery(image, opts);
    } catch {
      // The template provider is last and does not throw; a failed live hook falls through.
    }
  }
  return withGallery({ url: podMockupUrl(opts.preset, opts.niche), provider: "template-mockup", mocked: true }, opts);
}

/** Print file for Printify. The listing image may be a mockup; the design file is what gets printed. */
export function printArtworkUrl(listingImageUrl: string, designImageUrl?: string | null) {
  return designImageUrl || listingImageUrl;
}
