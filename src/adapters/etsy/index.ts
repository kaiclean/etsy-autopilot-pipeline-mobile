import type { DB } from "@/db";
import { hasEtsyCredentials } from "@/lib/config";
import { liveWritesEnabled } from "@/lib/read-publish-mode";
import { getSetting, setSetting } from "@/lib/settings";
import { EtsyLiveClient } from "./client";
import { EtsyDryRunAdapter } from "./dryrun";
import type { EtsyAdapter } from "./types";

/**
 * Reads use the live shop whenever credentials and OAuth tokens exist.
 * Writes also need the dashboard confirmation and host PUBLISH_MODE=live.
 */
export async function getEtsyAdapter(db: DB, random?: () => number, intent: "read" | "write" = "write"): Promise<EtsyAdapter> {
  const allowed = intent === "read" || (await liveWritesEnabled(db));
  if (allowed && hasEtsyCredentials()) {
    const tokens = await getSetting(db, "etsyTokens");
    if (tokens) return new EtsyLiveClient(tokens, (t) => setSetting(db, "etsyTokens", t));
  }
  return new EtsyDryRunAdapter(random);
}

export type { EtsyAdapter } from "./types";
