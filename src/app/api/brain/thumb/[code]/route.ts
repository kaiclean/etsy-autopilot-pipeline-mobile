import { readFile } from "node:fs/promises";
import path from "node:path";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import { config } from "@/lib/config";
import { thumbsDir } from "@/lib/brain/vault";

// No file extension in the URL on purpose: proxy.ts skips auth for *.webp, so this path stays
// behind the session check there, and we verify the session again here.
export async function GET(_req: Request, { params }: { params: Promise<{ code: string }> }) {
  const ok = await verifySessionToken((await cookies()).get(SESSION_COOKIE)?.value, config.authSecret);
  if (!ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { code } = await params;
  if (!/^[A-Za-z0-9_-]{3,40}$/.test(code)) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    const buf = await readFile(path.join(thumbsDir(), `${code}.webp`));
    return new NextResponse(new Uint8Array(buf), { headers: { "content-type": "image/webp", "cache-control": "private, max-age=86400" } });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
