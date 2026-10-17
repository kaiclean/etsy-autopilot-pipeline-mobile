import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireAuth } from "@/lib/session";
import { resolveRequestShop } from "@/lib/shops";
import { ArtworkExportError, createListingExports } from "@/pipeline/artwork-exports";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const MAX_REQUEST_BYTES = 8_192;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try { await requireAuth(); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const rawId = (await ctx.params).id;
  const id = Number(rawId);
  if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(id)) return NextResponse.json({ error: "Invalid listing id." }, { status: 400 });
  if (req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return NextResponse.json({ error: "Use application/json." }, { status: 415 });
  }
  try {
    const declared = Number(req.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) throw new ArtworkExportError("Export request is too large.", 413);
    const reader = req.body?.getReader();
    if (!reader) throw new ArtworkExportError("A JSON body is required.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new ArtworkExportError("Export request is too large.", 413);
      }
      chunks.push(value);
    }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks, size).toString("utf8")); }
    catch { throw new ArtworkExportError("Invalid JSON."); }
    const db = await getDb();
    const shop = await resolveRequestShop(db);
    return NextResponse.json(await createListingExports(db, shop.id, id, body));
  } catch (error) {
    if (error instanceof ArtworkExportError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "Artwork export failed; no Etsy writes were made." }, { status: 500 });
  }
}
