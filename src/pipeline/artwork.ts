import { decodeArtwork } from "@/lib/artwork-codec";
import { loadArtworkBytes } from "@/lib/artwork-source";
import { colorVariance, encodeRgbPng, placeholderPng, previewPng, shrinkToLongEdge } from "@/lib/png";

export type PreparedArt = {
  url: string;
  width: number | null;
  height: number | null;
  variance: number | null;
  visionPreview?: string;
};

/**
 * Measure a generated print file. Placeholder URLs are left as-is so the gate can reject them.
 * This measures the stored file after the shared upscale stage.
 */
export async function preparePrintFile(url: string): Promise<PreparedArt> {
  const bytes = placeholderPng(url) ?? previewPng(url) ?? await loadArtworkBytes(url);
  const image = bytes ? await decodeArtwork(bytes) : null;
  if (!image) return { url, width: null, height: null, variance: null };
  const variance = Math.round(colorVariance(image) * 10) / 10;
  const previewBytes = encodeRgbPng(shrinkToLongEdge(image, 512));
  const visionPreview = previewBytes.length < 2_000_000 ? `data:image/png;base64,${previewBytes.toString("base64")}` : undefined;
  return { url, width: image.width, height: image.height, variance, visionPreview };
}
