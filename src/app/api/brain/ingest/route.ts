import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { bearerMatches } from "@/lib/bearer";
import { getLiveVault } from "@/lib/brain/live-vault";
import { generateIdeaCandidates } from "@/lib/brain/idea-feed";
import { MAX_INGEST_BYTES, importNotes, ingestionHealth, ingestionStatus, recordIngestRun, validateIngest, validateSources } from "@/lib/brain/ingestion";
export const dynamic = "force-dynamic";
const authorized = (req: Request) => bearerMatches(req.headers.get("authorization"), process.env.BRAIN_SYNC_TOKEN);
export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = await getDb(), vault = await getLiveVault(db), status = await ingestionStatus(db);
  return NextResponse.json({ ...status, health: ingestionHealth(status), reels: vault.notes.filter(n => n.kind === "reel").map(n => ({
    id: n.id, shortcode: n.data.shortcode, status: n.data.status, dateProcessed: n.data.date_processed,
  })) }, { headers: { "cache-control": "no-store" } });
}
export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (Number(req.headers.get("content-length")) > MAX_INGEST_BYTES) return NextResponse.json({ error: "Import too large" }, { status: 413 });
  let parsed;
  try {
    const raw = await req.text();
    if (Buffer.byteLength(raw) > MAX_INGEST_BYTES) return NextResponse.json({ error: "Import too large" }, { status: 413 });
    parsed = validateIngest(JSON.parse(raw));
  } catch { return NextResponse.json({ error: "Invalid note import or run status" }, { status: 400 }); }
  const db = await getDb();
  try { validateSources(parsed.notes, await getLiveVault(db)); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
  await importNotes(db, parsed.notes);
  let candidates = 0;
  if (parsed.run.status === "succeeded") candidates = await generateIdeaCandidates(db);
  await recordIngestRun(db, parsed.run);
  return NextResponse.json({ accepted: parsed.notes.length, candidates }, { headers: { "cache-control": "no-store" } });
}
