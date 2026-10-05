import { podMockupPng } from "@/lib/png";

const PRESETS = ["posterA3", "mug", "tshirt", "sweatshirt"] as const;
type Preset = (typeof PRESETS)[number];

function isPreset(value: string): value is Preset {
  return (PRESETS as readonly string[]).includes(value);
}

export async function GET(req: Request, ctx: { params: Promise<{ preset: string }> }) {
  const { preset } = await ctx.params;
  if (!isPreset(preset)) return new Response("Unknown product", { status: 404 });
  const niche = new URL(req.url).searchParams.get("niche") ?? "alpine";
  const png = podMockupPng(preset, niche);
  return new Response(new Uint8Array(png), {
    headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
  });
}
