import { NextResponse } from "next/server";
import { getVault, searchIndex } from "@/lib/brain/vault";
// Session-protected by proxy.ts. Compact index for the brain quick search.
export const dynamic = "force-dynamic";
export function GET() {
  const docs = searchIndex(getVault()).map((d) => ({ id: d.id, kind: d.kind, title: d.title, handle: d.handle, date: d.date, thumb: d.thumb, summary: d.summary.slice(0, 160), text: d.text.slice(0, 6000) }));
  return NextResponse.json(docs, { headers: { "cache-control": "private, max-age=300" } });
}
