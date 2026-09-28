import { and, asc, desc, gt } from "drizzle-orm";
import { getDb } from "@/db";
import { events } from "@/db/schema";
import { visible } from "@/lib/events";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Server-Sent Events stream of new activity. Polls the events table every 2s and closes
 * after ~50s so it fits serverless limits; EventSource reconnects automatically with Last-Event-ID.
 */
export async function GET(req: Request) {
  const db = await getDb();
  const url = new URL(req.url);
  const lastHeader = req.headers.get("last-event-id") ?? url.searchParams.get("after");
  let cursor = Number(lastHeader);
  if (!Number.isFinite(cursor) || cursor <= 0) {
    const [latest] = await db.select({ id: events.id }).from(events).orderBy(desc(events.id)).limit(1);
    cursor = latest?.id ?? 0;
  }

  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream({
    async start(controller) {
      const send = (s: string) => {
        if (!closed) controller.enqueue(encoder.encode(s));
      };
      // Padding pushes the first chunk through proxies that buffer small SSE responses.
      send(`retry: 3000\n: ${" ".repeat(2048)}\n\n`);
      const started = Date.now();
      while (!closed && Date.now() - started < 50_000) {
        try {
          const rows = await db
            .select()
            .from(events)
            .where(and(gt(events.id, cursor), visible(events.isDemo)))
            .orderBy(asc(events.id))
            .limit(50);
          for (const r of rows) {
            cursor = r.id;
            send(`id: ${r.id}\nevent: activity\ndata: ${JSON.stringify(r)}\n\n`);
          }
          send(`: ping ${Date.now()}\n\n`);
        } catch {
          // transient DB error: keep the stream alive and retry
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      closed = true;
      controller.close();
    },
    cancel() {
      closed = true;
    },
  });
  req.signal.addEventListener("abort", () => {
    closed = true;
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
