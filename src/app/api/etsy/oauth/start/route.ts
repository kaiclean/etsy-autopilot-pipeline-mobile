import { NextResponse } from "next/server";
import { buildAuthorizeUrl, createPkcePair } from "@/adapters/etsy/oauth";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!config.etsy.apiKey) {
    return NextResponse.redirect(new URL("/settings?etsy=missing-key", req.url));
  }
  const redirectUri = config.etsy.redirectUri ?? new URL("/api/etsy/oauth/callback", req.url).toString();
  const { verifier, challenge, state } = await createPkcePair();
  const res = NextResponse.redirect(buildAuthorizeUrl({ challenge, state, redirectUri }));
  const opts = { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax" as const, path: "/", maxAge: 600 };
  res.cookies.set("etsy_pkce", verifier, opts);
  res.cookies.set("etsy_state", state, opts);
  return res;
}
