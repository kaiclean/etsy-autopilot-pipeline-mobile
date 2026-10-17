import { getDb } from "@/db";
import { etsyWebhookEnabled, EtsyWebhookError, readEtsyWebhookBody, recordEtsyDelivery } from "@/lib/etsy-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!etsyWebhookEnabled()) return Response.json({ error: "Etsy webhooks are disabled; polling remains enabled" }, { status: 503 });
  try {
    const raw = await readEtsyWebhookBody(request);
    // Verification deliberately precedes database initialization and any provider access.
    const { verifyEtsyWebhook } = await import("@/lib/etsy-webhook");
    const verified = await verifyEtsyWebhook(raw, request.headers);
    const result = await recordEtsyDelivery(await getDb(), raw, request.headers, async () => verified);
    return Response.json(result);
  } catch (error) {
    if (error instanceof EtsyWebhookError) return Response.json({ error: error.message }, { status: error.status });
    return Response.json({ error: "Webhook could not be persisted" }, { status: 503 });
  }
}
