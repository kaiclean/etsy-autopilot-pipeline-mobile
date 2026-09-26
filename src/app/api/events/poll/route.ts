import { and, asc, desc, gt } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { events } from "@/db/schema";
import { visible } from "@/lib/events";

export const dynamic = "force-dynamic";

/** Polling fallback for clients/networks where SSE is unavailable. */
export async function GET(req: Request) {
  const db = await getDb();
  const after = Number(new URL(req.url).searchParams.get("after") ?? 0);
  if (!after) {
    const [latest] = await db.select({ id: events.id }).from(events).orderBy(desc(events.id)).limit(1);
    return NextResponse.json({ cursor: latest?.id ?? 0, events: [] });
  }
  const rows = await db.select().from(events).where(and(gt(events.id, after), visible(events.isDemo))).orderBy(asc(events.id)).limit(50);
  return NextResponse.json({ cursor: rows.at(-1)?.id ?? after, events: rows });
}
