import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { sendTestPush } from "@/lib/push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sends a test notification to every stored subscription. Does not publish anything. */
export async function POST() {
  const db = await getDb();
  const result = await sendTestPush(db);
  if (result.skipped === "unconfigured") {
    return NextResponse.json({ error: "Web Push is not configured. Set the VAPID environment variables." }, { status: 503 });
  }
  if (result.skipped === "empty" || result.sent === 0) {
    return NextResponse.json({ error: "No push subscription yet. Enable notifications on this device first.", ...result }, { status: 409 });
  }
  return NextResponse.json({ ok: true, ...result });
}
