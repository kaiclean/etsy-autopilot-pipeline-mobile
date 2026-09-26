import type { DB } from "@/db";
import { config, hasEtsyCredentials } from "@/lib/config";
import { getSetting, setSetting } from "@/lib/settings";
import { EtsyLiveClient } from "./client";
import { EtsyDryRunAdapter } from "./dryrun";
import type { EtsyAdapter } from "./types";

/** Live only when PUBLISH_MODE=live, credentials exist and the shop has completed OAuth. */
export async function getEtsyAdapter(db: DB, random?: () => number): Promise<EtsyAdapter> {
  if (config.publishMode === "live" && hasEtsyCredentials()) {
    const tokens = await getSetting(db, "etsyTokens");
    if (tokens) return new EtsyLiveClient(tokens, (t) => setSetting(db, "etsyTokens", t));
  }
  return new EtsyDryRunAdapter(random);
}

export type { EtsyAdapter } from "./types";
