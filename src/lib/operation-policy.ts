import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import { shops } from "@/db/schema";
import { config } from "./config";
import { writesEnabled } from "./publish-mode";
import { getSetting } from "./settings";
import { assertExecutionLease } from "./operation-lease";

export class OperationPaused extends Error {}

/** Re-read at dispatch time: acquiring an adapter never grants lasting write permission. */
export async function assertOperationAllowed(db: DB, shopId: string, liveWrite = false) {
  await assertExecutionLease();
  const [automation, rows] = await Promise.all([
    getSetting(db, "automation"), db.select().from(shops).where(eq(shops.id, shopId)),
  ]);
  const shop = rows[0];
  if (!shop || automation.killSwitch || shop.killSwitch || ["paused", "archived"].includes(shop.status)) {
    throw new OperationPaused("Automation paused: operation blocked before dispatch");
  }
  if (liveWrite && !writesEnabled(automation.publishMode, config.publishMode)) {
    throw new Error("Live writes disabled: operation blocked before dispatch");
  }
}
