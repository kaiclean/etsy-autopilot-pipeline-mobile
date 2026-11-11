import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
export const dynamic = "force-dynamic";
/** Owner-only download: never put the worker credential in HTML or source control. */
export async function GET(req: Request) {
  if (!await verifySessionToken((await cookies()).get(SESSION_COOKIE)?.value, config.authSecret)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!process.env.BRAIN_SYNC_TOKEN) return NextResponse.json({ error: "The host needs BRAIN_SYNC_TOKEN before connecting a Mac" }, { status: 503 });
  const origin = process.env.APP_URL || new URL(req.url).origin;
  const text = `# Private Mac worker configuration. Do not share or commit.\nBRAIN_BASE_URL=${origin}\nBRAIN_SYNC_TOKEN=${process.env.BRAIN_SYNC_TOKEN}\nINSTAGRAM_USERNAME=\nINSTAGRAM_SESSION_FILE=\nOLLAMA_BASE_URL=http://127.0.0.1:11434\nOLLAMA_MODEL=gemma3:4b\nWHISPER_MODEL=base\nBRAIN_DAILY_HOUR=7\nBRAIN_DAILY_MINUTE=20\nBRAIN_MAX_REELS=12\nBRAIN_SCAN_LIMIT=200\n`;
  return new NextResponse(text, { headers: { "content-type": "text/plain; charset=utf-8", "content-disposition": 'attachment; filename=".env.brain"', "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
}
