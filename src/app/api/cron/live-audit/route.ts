import { eq, isNotNull, and } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { designs, listings } from "@/db/schema";
import { getEtsyAdapter } from "@/adapters/etsy";
import { config } from "@/lib/config";
import { authorizedUpscaleJob } from "@/lib/upscale-jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Read-only: every listing with an Etsy id, its design + upscale method, and Etsy's own state
 * (getListing via the read adapter). Optional ?blueprints=6:26:12101,49:26:25427 returns Printify
 * print-area placeholders. Never writes, never returns tokens.
 */
export async function GET(req: Request) {
  if (!authorizedUpscaleJob(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = await getDb();
  const rows = await db.select({ l: listings, d: designs }).from(listings).leftJoin(designs, eq(listings.designId, designs.id))
    .where(and(isNotNull(listings.etsyListingId), eq(listings.isDemo, false))).orderBy(listings.id);
  const etsy = await getEtsyAdapter(db, undefined, "read").catch(() => null);
  const items = [];
  for (const { l, d } of rows) {
    let etsyState: string | null = null;
    let etsyError: string | null = null;
    if (etsy?.getListing && l.etsyListingId) {
      try { etsyState = (await etsy.getListing(l.etsyListingId)).state; } catch (error) { etsyError = error instanceof Error ? error.message.slice(0, 120) : "error"; }
    }
    items.push({
      id: l.id, designId: l.designId, status: l.status, productType: l.productType, podProvider: l.podProvider, publishMode: l.publishMode,
      etsyListingId: l.etsyListingId, etsyState, etsyError, activatedAt: l.activatedAt, approvedAt: l.approvedAt, updatedAt: l.updatedAt, createdAt: l.createdAt,
      design: d ? { upscaleMethod: d.upscaleMethod, width: d.imageWidth, height: d.imageHeight, sourcePx: d.sourcePx } : null,
      deliveryUrl: l.deliveryUrl,
    });
  }
  const placeholders: unknown[] = [];
  const spec = new URL(req.url).searchParams.get("blueprints");
  if (spec && config.printify.token) {
    for (const part of spec.split(",").slice(0, 4)) {
      const [bp, pp, variant] = part.split(":").map(Number);
      if (!bp || !pp) continue;
      const res = await fetch(`https://api.printify.com/v1/catalog/blueprints/${bp}/print_providers/${pp}/variants.json?show-out-of-stock=1`, {
        headers: { Authorization: ["Bearer", config.printify.token].join(" "), "User-Agent": "EtsyAutopilot" }, signal: AbortSignal.timeout(15_000),
      });
      const body = res.ok ? await res.json() as { variants?: { id: number; title: string; placeholders?: { position: string; width: number; height: number }[] }[] } : null;
      const rows = (body?.variants ?? []).filter((v) => !variant || v.id === variant).slice(0, 3)
        .map((v) => ({ id: v.id, title: v.title, placeholders: v.placeholders }));
      placeholders.push({ blueprintId: bp, printProviderId: pp, http: res.status, variants: rows });
    }
  }
  return NextResponse.json({ count: items.length, etsyAdapter: Boolean(etsy?.getListing), items, placeholders });
}
