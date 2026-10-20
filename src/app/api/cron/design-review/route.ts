import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { signOffDesign } from "@/lib/design-review";
import { authorizedUpscaleJob } from "@/lib/upscale-jobs";

export const dynamic = "force-dynamic";

/** POST ?id=&verdict=approve|reject&note= — Design's sign-off. Only approve clears needs_redesign. */
export async function POST(req: Request) {
  if (!authorizedUpscaleJob(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const p = new URL(req.url).searchParams;
  const id = Number(p.get("id"));
  const verdict = p.get("verdict");
  if (!Number.isInteger(id) || id < 1 || (verdict !== "approve" && verdict !== "reject")) return NextResponse.json({ error: "id and verdict=approve|reject required" }, { status: 400 });
  const out = await signOffDesign(await getDb(), id, verdict, p.get("note")?.slice(0, 300) || undefined);
  return out ? NextResponse.json(out) : NextResponse.json({ error: "not found" }, { status: 404 });
}
