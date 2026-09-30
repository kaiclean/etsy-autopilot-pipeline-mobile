import type { DB } from "@/db";
import { effectivePublishMode, type PublishMode } from "./publish-mode";
import { getSetting } from "./settings";

/** Dashboard choice, defaulting to dry-run. The PUBLISH_MODE env var is not enough on its own. */
export async function readPublishMode(db: DB): Promise<PublishMode> {
  const automation = await getSetting(db, "automation");
  return effectivePublishMode(automation.publishMode);
}