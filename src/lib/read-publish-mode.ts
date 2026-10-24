import type { DB } from "@/db";
import { config } from "./config";
import { effectivePublishMode, writesEnabled, type PublishMode } from "./publish-mode";
import { resolveActiveShop } from "./shops";
import { getSetting } from "./settings";

/** Dashboard choice, defaulting to dry-run. The PUBLISH_MODE env var is not enough on its own. */
export async function readPublishMode(db: DB): Promise<PublishMode> {
  const automation = await getSetting(db, "automation");
  return effectivePublishMode(automation.publishMode);
}

/** Host dry-run blocks writes even when the dashboard choice is live. */
export async function liveWritesEnabled(db: DB,shopId?:string): Promise<boolean> {
  const [automation, shop] = await Promise.all([getSetting(db, "automation"), resolveActiveShop(db,shopId)]);
  return !automation.killSwitch && !shop.killSwitch && !["paused", "archived"].includes(shop.status) && writesEnabled(automation.publishMode, config.publishMode);
}