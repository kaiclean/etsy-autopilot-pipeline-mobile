import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireAuth } from "@/lib/session";
import { listShopsPublic } from "@/lib/shops";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const db = await getDb();
  const shop = (await listShopsPublic(db)).find((row) => row.id === id);
  if (!shop) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ shop });
}
