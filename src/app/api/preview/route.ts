import { digitalPreviewPng } from "@/lib/png";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const niche = url.searchParams.get("niche") ?? "alpine";
  const src = url.searchParams.get("src") ?? "";
  const png = digitalPreviewPng(niche, src);
  return new Response(new Uint8Array(png), {
    headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
  });
}
