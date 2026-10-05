import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireAuth } from "@/lib/session";
import { listShopsPublic } from "@/lib/shops";

export const dynamic = "force-dynamic";

/** List registered shops. There is no POST in M1; adding a shop is the M3 wizard. */
export async function GET() {
  try {
    await requireAuth();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const db = await getDb();
  const shops = await listShopsPublic(db);
  return NextResponse.json({ shops });
}
