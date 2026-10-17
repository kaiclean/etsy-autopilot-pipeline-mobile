import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { FINANCE_IMPORT_MAX_BYTES, FinanceImportError, importFinancialEvidence } from "@/lib/etsy-finance";
import { requireAuth } from "@/lib/session";
import { resolveRequestShop } from "@/lib/shops";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try { await requireAuth(); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  if (!req.headers.get("content-type")?.includes("application/json")) {
    return NextResponse.json({ error: "Use application/json with normalized seller observations." }, { status: 415 });
  }
  try {
    const reader = req.body?.getReader();
    if (!reader) throw new FinanceImportError("A JSON body is required.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > FINANCE_IMPORT_MAX_BYTES) {
        await reader.cancel();
        throw new FinanceImportError("Import exceeds 256000 bytes.", 413);
      }
      chunks.push(value);
    }
    let input: unknown;
    try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new FinanceImportError("Invalid JSON."); }
    const db = await getDb();
    const shop = await resolveRequestShop(db);
    return NextResponse.json(await importFinancialEvidence(db, shop.id, input));
  } catch (error) {
    if (error instanceof FinanceImportError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "Financial evidence import failed. No order estimates were changed." }, { status: 500 });
  }
}
