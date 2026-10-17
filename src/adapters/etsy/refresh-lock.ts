import { randomUUID } from "node:crypto";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import type { DB } from "@/db";
import { etsySyncState } from "@/db/etsy-sync";

/** A DB lease coordinates OAuth refreshes across workers and web instances. */
export async function withEtsyRefreshLease<T>(db: DB, shopId: string, work: () => Promise<T>): Promise<T> {
  await db.insert(etsySyncState).values({ shopId }).onConflictDoNothing();
  const owner = randomUUID();
  for (let attempt = 0; attempt < 25; attempt++) {
    const now = new Date();
    const acquired = await db.update(etsySyncState)
      .set({ refreshLeaseOwner: owner, refreshLeaseUntil: new Date(now.getTime() + 30_000) })
      .where(and(eq(etsySyncState.shopId, shopId),
        or(isNull(etsySyncState.refreshLeaseUntil), lt(etsySyncState.refreshLeaseUntil, now))))
      .returning({ shopId: etsySyncState.shopId });
    if (acquired.length) {
      try {
        return await work();
      } finally {
        await db.update(etsySyncState).set({ refreshLeaseOwner: null, refreshLeaseUntil: null })
          .where(and(eq(etsySyncState.shopId, shopId), eq(etsySyncState.refreshLeaseOwner, owner)));
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Etsy token refresh busy; retry on a later run");
}
