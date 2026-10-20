import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { listings } from "@/db/schema";
import { prepareSupplierPreview } from "@/pipeline/supplier-preview";
import { authorizedUpscaleJob } from "@/lib/upscale-jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** POST ?id=<listing> — regenerate Printify supplier mockups (draft product, never published or approved). */
export async function POST(req: Request) {
  if (!authorizedUpscaleJob(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id < 1) return NextResponse.json({ error: "id required" }, { status: 400 });
  const db = await getDb();
  const [row] = await db.select().from(listings).where(eq(listings.id, id));
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (row.activatedAt || row.etsyListingId) return NextResponse.json({ error: "listing is on Etsy; not touched" }, { status: 409 });
  const result = await prepareSupplierPreview(db, row);
  console.log(`[mockups] listing #${id} ${row.podProvider}: ready=${result.ready} product=${result.listing.printifyProductId ?? "none"} file=${row.deliveryUrl ?? "none"}`);
  return NextResponse.json({
    id, ready: result.ready, error: result.error, printifyProductId: result.listing.printifyProductId, printFile: row.deliveryUrl,
    mockups: (result.listing.gallery ?? []).filter((view) => view.source === "supplier").map((view) => view.url),
    status: result.listing.status,
  });
}
