import { NextResponse, type NextRequest } from "next/server";
import { exchangeCode } from "@/adapters/etsy/oauth";
import { getDb } from "@/db";
import { config } from "@/lib/config";
import { emit } from "@/lib/events";
import { setSetting } from "@/lib/settings";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const verifier = req.cookies.get("etsy_pkce")?.value;
  const expectedState = req.cookies.get("etsy_state")?.value;
  const back = (q: string) => {
    const res = NextResponse.redirect(new URL(`/settings?etsy=${q}`, req.url));
    res.cookies.delete("etsy_pkce");
    res.cookies.delete("etsy_state");
    return res;
  };
  if (url.searchParams.get("error")) return back("denied");
  if (!code || !verifier || !state || state !== expectedState) return back("invalid-state");

  try {
    const redirectUri = config.etsy.redirectUri ?? new URL("/api/etsy/oauth/callback", req.url).toString();
    const tokens = await exchangeCode({ code, verifier, redirectUri });
    const db = await getDb();
    await setSetting(db, "etsyTokens", tokens);
    await emit(db, { type: "etsy.connected", title: "Etsy shop connected", body: `User ${tokens.userId}`, severity: "success", href: "/settings" });
    return back("connected");
  } catch {
    return back("token-error");
  }
}
