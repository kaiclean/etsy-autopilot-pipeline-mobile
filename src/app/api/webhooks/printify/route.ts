import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { authorizePrintifyWebhook, ingestPrintifyWebhook } from "@/lib/printify-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Printify webhook callback. Register each topic against this URL and pass
 * PRINTIFY_WEBHOOK_SECRET as the webhook `secret` so deliveries are signed
 * in the `x-pfy-signature` header. Stores the mapping only — no live API calls.
 */
export async function POST(req: Request) {
  const rawBody = await req.text();
  const auth = authorizePrintifyWebhook(rawBody, req.headers.get("x-pfy-signature"));
  if (auth === "missing-secret") {
    return NextResponse.json({ error: "PRINTIFY_WEBHOOK_SECRET is required in production" }, { status: 401 });
  }
  if (auth === "bad-signature") {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const db = await getDb();
  const result = await ingestPrintifyWebhook(db, { rawBody, payload, verified: auth === "verified" });
  return NextResponse.json({
    ok: true,
    duplicate: result.duplicate,
    topic: result.topic,
    verified: result.verified,
    listingUpdated: result.listingUpdated,
    orderUpdated: result.orderUpdated,
  });
}
