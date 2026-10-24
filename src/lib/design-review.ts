import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import { designs } from "@/db/schema";

/** Approval is blocked while a design is flagged for redesign or awaiting Design's sign-off. */
export async function designReviewBlocker(db: DB, designId: number) {
  const [row] = await db.select({ flag: designs.needsRedesign, review: designs.designReview }).from(designs).where(eq(designs.id, designId));
  if (!row) return "Design is missing; review the artwork before approval.";
  if (row.review?.status === "pending") return "Design review pending: Design must sign off the new artwork before approval.";
  if (row.review?.status === "rejected") return `Design rejected the artwork${row.review.note ? `: ${row.review.note}` : ""}.`;
  if (row.flag) return "Design is flagged for redesign.";
  return null;
}

/** Design sign-off: approve clears needs_redesign; reject keeps/re-sets it (from the stored flag or a fresh one). */
export async function signOffDesign(db: DB, designId: number, verdict: "approve" | "reject", note?: string) {
  const [row] = await db.select({ flag: designs.needsRedesign, w: designs.imageWidth, h: designs.imageHeight }).from(designs).where(eq(designs.id, designId));
  if (!row) return null;
  const at = new Date().toISOString();
  if (verdict === "approve") {
    await db.update(designs).set({ needsRedesign: null, designReview: { status: "approved", note, at } }).where(eq(designs.id, designId));
  } else {
    const flag = row.flag ?? { reason: `Design zoom check failed${note ? `: ${note}` : ""}`, sourcePx: { width: row.w ?? 0, height: row.h ?? 0 },
      target: { minW: 4016, minH: 5057, targetW: 4016, targetH: 5057 }, presets: [], scale: 4, at };
    await db.update(designs).set({ needsRedesign: { ...flag, reason: `Design zoom check failed${note ? `: ${note}` : ""}`, at }, designReview: { status: "rejected", note, at } }).where(eq(designs.id, designId));
  }
  console.log(`[design-review] design #${designId} ${verdict}${note ? `: ${note}` : ""}`);
  return { designId, verdict, at };
}

/** Shared by every approval and publication entry point. */
export async function approvalBlocker(db: DB, listing: { designId: number | null; validation: {code:string;message:string}[] }) {
  const held = listing.validation.find(issue => ["mockups_stale", "print_file_held"].includes(issue.code));
  if (held) return held.message;
  return listing.designId ? designReviewBlocker(db, listing.designId) : null;
}
