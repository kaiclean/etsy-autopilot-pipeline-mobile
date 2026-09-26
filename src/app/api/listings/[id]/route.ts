import { NextResponse } from "next/server";
import { setListingStatus, updateListing } from "@/app/actions";

export const dynamic = "force-dynamic";

type Body =
  | { action: "approve" }
  | { action: "reject"; reason?: string }
  | { action: "edit"; title: string; tags: string[]; priceChf: number; description?: string; approve?: boolean };

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  const body = (await req.json()) as Body;
  if (body.action === "approve") return NextResponse.json(await setListingStatus(id, "approved"));
  if (body.action === "reject") return NextResponse.json(await setListingStatus(id, "rejected", body.reason));
  if (body.action === "edit") {
    const { title, tags, priceChf, description, approve } = body;
    return NextResponse.json(await updateListing(id, { title, tags, priceChf, description }, approve));
  }
  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
