import { timingSafeEqual } from "node:crypto";
import { getDb } from "@/db";
import { config } from "@/lib/config";
import { drainEtsyEvents, enqueueEtsyReconciliation, EtsyReconciliationRequestError, etsyEventsEnabled, openEtsyQueue } from "@/lib/etsy-jobs";
import { EtsyWebhookError, readEtsyWebhookBody } from "@/lib/etsy-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorized(request: Request) {
  const secret = config.cronSecret;
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(["Bearer", secret ?? ""].join(" "));
  return Boolean(secret) && actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!etsyEventsEnabled()) return Response.json({ enabled: false, pollingRecovery: true });
  let queue: Awaited<ReturnType<typeof openEtsyQueue>> | undefined;
  try {
    queue = await openEtsyQueue();
    return Response.json(await drainEtsyEvents(await getDb(), queue));
  } catch {
    return Response.json({ error: "Etsy event drain failed; inbox retained for retry" }, { status: 503 });
  } finally {
    await queue?.stop().catch(() => {});
  }
}

/** Operator enqueue only. The scheduled GET owns draining; this is not a public webhook fallback. */
export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!etsyEventsEnabled()) return Response.json({ error: "Etsy event processing is disabled" }, { status: 503 });
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
    return Response.json({ error: "Expected application/json" }, { status: 415 });
  }
  try {
    const raw = await readEtsyWebhookBody(request, 1024);
    let input: unknown;
    try { input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); }
    catch { return Response.json({ error: "Invalid reconciliation JSON" }, { status: 400 }); }
    const result = await enqueueEtsyReconciliation(await getDb(), input, request.headers.get("idempotency-key"));
    return Response.json(result, { status: 202 });
  } catch (error) {
    if (error instanceof EtsyReconciliationRequestError || error instanceof EtsyWebhookError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: "Reconciliation request could not be persisted" }, { status: 503 });
  }
}
