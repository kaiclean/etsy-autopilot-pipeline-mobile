import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { config, vapidConfigured } from "@/lib/config";
import { deletePushSubscription, savePushSubscription, validPushEndpoint } from "@/lib/push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const configured = vapidConfigured();
  return NextResponse.json({
    configured,
    publicKey: configured ? config.vapid.publicKey : null,
  });
}

export async function POST(req: Request) {
  if (!vapidConfigured()) {
    return NextResponse.json({ error: "Web Push is not configured. Set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT." }, { status: 503 });
  }
  let body: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const p256dh = body.keys?.p256dh;
  const auth = body.keys?.auth;
  if (!validPushEndpoint(body.endpoint) || typeof p256dh !== "string" || typeof auth !== "string" || !p256dh || !auth) {
    return NextResponse.json({ error: "invalid subscription" }, { status: 400 });
  }
  const db = await getDb();
  await savePushSubscription(db, {
    endpoint: body.endpoint,
    p256dh,
    auth,
    userAgent: req.headers.get("user-agent"),
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  let body: { endpoint?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  if (!validPushEndpoint(body.endpoint)) return NextResponse.json({ error: "invalid subscription" }, { status: 400 });
  const db = await getDb();
  await deletePushSubscription(db, body.endpoint);
  return NextResponse.json({ ok: true });
}
