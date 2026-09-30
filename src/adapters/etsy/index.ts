import type { DB } from "@/db";
import { hasEtsyCredentials } from "@/lib/config";
import { readPublishMode } from "@/lib/read-publish-mode";
import { getSetting, setSetting } from "@/lib/settings";
import { EtsyLiveClient } from "./client";
import { EtsyDryRunAdapter } from "./dryrun";
import type { EtsyAdapter } from "./types";

/** Live only after the dashboard go-live confirmation, and only when credentials and OAuth tokens exist. */
export async function getEtsyAdapter(db: DB, random?: () => number): Promise<EtsyAdapter> {
  if ((await readPublishMode(db)) === "live" && hasEtsyCredentials()) {
    const tokens = await getSetting(db, "etsyTokens");
    if (tokens) return new EtsyLiveClient(tokens, (t) => setSetting(db, "etsyTokens", t));
  }
  return new EtsyDryRunAdapter(random);
}

export type { EtsyAdapter } from "./types";
