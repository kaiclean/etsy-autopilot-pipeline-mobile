import { eq, sql } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { getDb, type DB } from "@/db";
import { listings, shops } from "@/db/schema";
import { resolveActiveShop } from "@/lib/shops";
import { runStage } from "@/pipeline/runner";

// Each test names a gate and fails if that gate is removed: the approval requirement for publishing and the
// per-shop kill switch (the global switch and the AI spend caps are pinned in pipeline.e2e and ai-budget tests).
describe("safety gates", () => {
  let db: DB;
  const created: number[] = [];

  beforeAll(async () => {
    db = await getDb();
  });

  afterEach(async () => {
    for (const id of created.splice(0)) await db.delete(listings).where(eq(listings.id, id));
    await db.update(shops).set({ killSwitch: false });
  });

  async function insertFrom(status: "pending_approval" | "rejected") {
    const [src] = await db.select().from(listings).limit(1);
    const [row] = await db
      .insert(listings)
      .values({
        designId: src.designId,
        keywordId: src.keywordId,
        niche: src.niche,
        productType: "digital",
        title: "Gate test listing",
        tags: src.tags,
        description: src.description,
        imageUrl: src.imageUrl,
        priceChf: src.priceChf,
        podCostChf: src.podCostChf,
        netChf: src.netChf,
        marginPct: src.marginPct,
        validation: [],
        status,
        isDemo: true,
      })
      .returning();
    created.push(row.id);
    return row;
  }

  it("publish never touches listings that are not approved", async () => {
    // Park everything publishable so only the two unapproved rows are candidates.
    await db.update(listings).set({ status: "rejected" }).where(sql`${listings.status} IN ('approved', 'failed')`);
    const pending = await insertFrom("pending_approval");
    const rejected = await insertFrom("rejected");

    const run = await runStage("publish", "manual", { db });
    expect(run.summary).toMatch(/Nothing approved to publish/);

    for (const row of [pending, rejected]) {
      const [after] = await db.select().from(listings).where(eq(listings.id, row.id));
      expect(after.status).toBe(row.status);
      expect(after.publishAttemptCount).toBe(0);
      expect(after.publishAttemptedAt).toBeNull();
    }
  });

  it("the shop-level kill switch skips a stage even when the global switch is off", async () => {
    const shop = await resolveActiveShop(db);
    await db.update(shops).set({ killSwitch: true }).where(eq(shops.id, shop.id));
    const run = await runStage("analytics", "manual", { db });
    expect(run.status).toBe("skipped");
    expect(run.summary).toMatch(/Shop kill switch/);
  });
});
