import { isPlaceholderUrl, isSafeArtworkUrl } from "@/lib/art-quality";
import { decodePng, placeholderPng, podMockupPng, previewPng, type RgbImage } from "@/lib/png";

async function artworkFor(src: string | null): Promise<RgbImage | null> {
  if (!src || isPlaceholderUrl(src) || src.includes("/api/mockup/")) return null;
  const local = placeholderPng(src) ?? previewPng(src);
  if (local) return decodePng(local);
  if (!isSafeArtworkUrl(src)) return null;
  try {
    const res = await fetch(src, { redirect: "error", signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length === 0 || bytes.length > 12_000_000) return null;
    return decodePng(bytes);
  } catch {
    return null;
  }
}

const PRESETS = ["posterA3", "mug", "tshirt", "sweatshirt"] as const;
type Preset = (typeof PRESETS)[number];

function isPreset(value: string): value is Preset {
  return (PRESETS as readonly string[]).includes(value);
}

export async function GET(req: Request, ctx: { params: Promise<{ preset: string }> }) {
  const { preset } = await ctx.params;
  if (!isPreset(preset)) return new Response("Unknown product", { status: 404 });
  const url = new URL(req.url);
  const niche = url.searchParams.get("niche") ?? "alpine";
  const artwork = await artworkFor(url.searchParams.get("src"));
  const png = podMockupPng(preset, niche, artwork);
  return new Response(new Uint8Array(png), {
    headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
  });
}
