import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { loadPipelineLive } from "@/lib/pipeline-live";
import { requireAuth } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    await requireAuth();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const errorsOnly = new URL(req.url).searchParams.get("errors") === "1";
  const live = await loadPipelineLive(await getDb(), { errorsOnly, limit: 20 });
  return NextResponse.json(live);
}
