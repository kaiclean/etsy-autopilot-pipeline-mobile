import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import { config as appConfig } from "@/lib/config";

const PUBLIC_PATHS = ["/login", "/manifest.webmanifest", "/sw.js", "/offline"];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (PUBLIC_PATHS.includes(pathname) || pathname.startsWith("/icons/") || pathname.startsWith("/api/cron/")) {
    return NextResponse.next();
  }
  const ok = await verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value, appConfig.authSecret);
  if (ok) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/|favicon.ico|.*\\.(?:png|svg|jpg|ico|webp)$).*)"],
};
