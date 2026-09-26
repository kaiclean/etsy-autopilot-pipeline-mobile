import { ImageResponse } from "next/og";

const ALLOWED = new Set([180, 192, 512]);

export async function GET(req: Request, ctx: { params: Promise<{ size: string }> }) {
  const n = Number((await ctx.params).size);
  const size = ALLOWED.has(n) ? n : 192;
  const maskable = new URL(req.url).searchParams.has("maskable");
  const pad = maskable ? size * 0.18 : 0;
  const inner = size - pad * 2;
  return new ImageResponse(
    (
      <div style={{ width: size, height: size, display: "flex", alignItems: "center", justifyContent: "center", background: "#0b0c10" }}>
        <div
          style={{
            width: inner,
            height: inner,
            borderRadius: maskable ? inner * 0.5 : inner * 0.22,
            background: "linear-gradient(145deg, #7ef0c4 0%, #2fb488 100%)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <svg width={inner * 0.6} height={inner * 0.6} viewBox="0 0 24 24" fill="none">
            <path d="M3 19 L9.5 8 L13 14 L15.5 10 L21 19 Z" fill="#0b0c10" />
            <circle cx="17" cy="6" r="2" fill="#0b0c10" />
          </svg>
        </div>
      </div>
    ),
    { width: size, height: size, headers: { "Cache-Control": "public, max-age=86400" } },
  );
}
