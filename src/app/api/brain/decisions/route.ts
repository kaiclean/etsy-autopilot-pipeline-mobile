import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { listDecisions } from "@/lib/brain/decisions";

// Hermes reads Kai's verdicts here. Exempt from the session check in proxy.ts; bearer token instead.
export const dynamic = "force-dynamic";
function authorized(req: NextRequest) {
  const want = process.env.OMNIGRAM_API_TOKEN;
  const got = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!want || !got) return false;
  const a = Buffer.from(got), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}
export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const s = req.nextUrl.searchParams.get("since");
  const since = s ? new Date(s) : undefined;
  if (since && Number.isNaN(since.getTime())) return NextResponse.json({ error: "bad since" }, { status: 400 });
  const rows = await listDecisions(since);
  return NextResponse.json({ decisions: rows.map((d) => ({ id: d.id, idea_id: d.idea_id, verdict: d.verdict, comment: d.comment, priority: d.priority, phrase: d.phrase, niche: d.niche, keyword_id: d.keywordId, design_brief_id: d.designBriefId, created_at: d.created_at })) });
}
