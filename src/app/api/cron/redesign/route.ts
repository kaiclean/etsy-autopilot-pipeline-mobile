import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { regenerateFlaggedDesign } from "@/lib/redesign";
import { authorizedUpscaleJob } from "@/lib/upscale-jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** POST ?id=130 — re-render one flagged design (own prompt, 1024×1280 print model). Respects the daily AI cap. */
export async function POST(req: Request) {
  if (!authorizedUpscaleJob(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id < 1) return NextResponse.json({ error: "id required" }, { status: 400 });
  try {
    return NextResponse.json(await regenerateFlaggedDesign(await getDb(), id));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message.slice(0, 200) : "redesign failed" }, { status: 422 });
  }
}
