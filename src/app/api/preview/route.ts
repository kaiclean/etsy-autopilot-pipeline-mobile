import { renderArtworkPreview } from "@/lib/artwork-source";
import { digitalPreviewPng } from "@/lib/png";

export const runtime = "nodejs";

/** Downscaled real artwork when `src` loads. The flat niche card is only for demo placeholder art. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const real = await renderArtworkPreview(request.url);
  const png = real ?? digitalPreviewPng(url.searchParams.get("niche") ?? "alpine", url.searchParams.get("src") ?? "");
  return new Response(new Uint8Array(png), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": real ? "public, max-age=86400" : "no-store",
      "X-Preview-Source": real ? "artwork" : "placeholder",
    },
  });
}
