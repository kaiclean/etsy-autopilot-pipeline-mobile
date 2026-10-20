import { and, eq, inArray, isNull } from "drizzle-orm";
import type { DB } from "@/db";
import { designs, listings } from "@/db/schema";

export const QUEUE_STATUSES = ["pending_approval", "quality_failed", "needs_review"] as const;

/** Words used in more than one tag (case-insensitive), with their counts. */
export function repeatedTagWords(tags: readonly string[]) {
  const counts = new Map<string, number>();
  for (const tag of tags) for (const word of new Set(tag.toLowerCase().split(/[^a-z0-9äöüß]+/).filter((w) => w.length > 2))) counts.set(word, (counts.get(word) ?? 0) + 1);
  return Object.fromEntries([...counts].filter(([, n]) => n > 1));
}

export async function reviewQueue(db: DB) {
  const rows = await db.select({ listing: listings, design: designs }).from(listings)
    .leftJoin(designs, eq(listings.designId, designs.id))
    .where(and(inArray(listings.status, [...QUEUE_STATUSES] as never), isNull(listings.activatedAt), eq(listings.isDemo, false)))
    .orderBy(listings.id);
  return rows.map(({ listing: l, design: d }) => {
    const gallery = l.gallery ?? [];
    return {
      id: l.id, designId: l.designId, status: l.status, productType: l.productType, niche: l.niche,
      failures: (l.validation ?? []).filter((issue) => issue.severity === "error").map((issue) => ({ code: issue.code, message: issue.message })),
      warnings: (l.validation ?? []).filter((issue) => issue.severity !== "error").map((issue) => issue.code),
      design: d ? { width: d.imageWidth, height: d.imageHeight, upscaleMethod: d.upscaleMethod, printTarget: d.printTarget, imageUrl: d.imageUrl, status: d.status } : null,
      preset: { podProvider: l.podProvider, supplier: l.supplier, blueprintId: l.podBlueprintId, printProviderId: l.podPrintProviderId, printifyProductId: l.printifyProductId },
      mockups: { total: gallery.length, supplier: gallery.filter((view) => view.source === "supplier").length, views: gallery.map((view) => ({ role: view.role, source: view.source ?? null, label: view.label, url: view.url })) },
      margin: { priceChf: l.priceChf, podCostChf: l.podCostChf, netChf: l.netChf, marginPct: l.marginPct },
      copy: { title: l.title, titleLength: l.title.length, tagCount: l.tags.length, tags: l.tags, repeatedTagWords: repeatedTagWords(l.tags), description: l.description.slice(0, 600) },
      delivery: { deliveryUrl: l.deliveryUrl, fileManifest: l.fileManifest ?? null, fileVerifiedAt: l.fileVerifiedAt },
    };
  });
}
