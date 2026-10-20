import { bearerMatches } from "@/lib/bearer";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/db";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import { config } from "@/lib/config";
import { runDeepHealth } from "@/lib/deep-health";

// Session cookie or bearer OMNIGRAM_API_TOKEN. Reports env var names (present/absent) and status codes, never values.
export const dynamic = "force-dynamic";
const bearerOk = (req: NextRequest) => bearerMatches(req.headers.get("authorization"), process.env.OMNIGRAM_API_TOKEN);
export async function GET(req: NextRequest) {
  const ok = bearerOk(req) || (await verifySessionToken(req.cookies.get(SESSION_COOKIE)?.value, config.authSecret));
  if (!ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const res = await runDeepHealth(await getDb(), { fresh: req.nextUrl.searchParams.get("fresh") === "1" });
  return NextResponse.json(res, { status: res.overall === "fail" ? 503 : 200, headers: { "cache-control": "no-store" } });
}
