import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import { publicAppOrigin } from "@/lib/setup-guide";
export const dynamic = "force-dynamic";
/** Owner-only download: never put the worker credential in HTML or source control. */
export async function GET(req: Request) {
  if (!await verifySessionToken((await cookies()).get(SESSION_COOKIE)?.value, config.authSecret)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!process.env.BRAIN_SYNC_TOKEN) return NextResponse.json({ error: "The host needs BRAIN_SYNC_TOKEN before connecting a worker" }, { status: 503 });
  const origin = publicAppOrigin() ?? new URL(req.url).origin;
  const text = `# Private saved-reel worker configuration. Do not share or commit.
APP_URL=${origin}
BRAIN_SYNC_TOKEN=${process.env.BRAIN_SYNC_TOKEN}
INSTAGRAM_USERNAME=
INSTAGRAM_SESSION_FILE=
INSTAGRAM_COOKIES_FROM=
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=gemma3:4b
WHISPER_MODEL=base
BRAIN_RUN_TIMES=07:20,19:20
BRAIN_MAX_REELS=12
BRAIN_SCAN_LIMIT=200
`;
  return new NextResponse(text, { headers: { "content-type": "text/plain; charset=utf-8", "content-disposition": 'attachment; filename=".env.brain"', "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
}
