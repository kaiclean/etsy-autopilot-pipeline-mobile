import type { DB } from "@/db";
import { config, hasEtsyCredentials } from "@/lib/config";
import { liveWritesEnabled } from "@/lib/read-publish-mode";
import { readEtsyTokens, resolveActiveShop, writeEtsyTokens } from "@/lib/shops";
import { EtsyLiveClient } from "./client";
import { EtsyDryRunAdapter } from "./dryrun";
import type { EtsyAdapter } from "./types";

/**
 * Reads use the live shop whenever credentials and OAuth tokens exist.
 * Writes also need the dashboard confirmation and host PUBLISH_MODE=live.
 * Shop id and tokens prefer the shop row, then settings.etsyTokens, then ETSY_SHOP_ID.
 */
export async function getEtsyAdapter(db: DB, random?: () => number, intent: "read" | "write" = "write"): Promise<EtsyAdapter> {
  const shop = await resolveActiveShop(db);
  const shopId = shop.etsyShopId?.trim() || config.etsy.shopId;
  const allowed = intent === "read" || (await liveWritesEnabled(db));
  if (allowed && hasEtsyCredentials(shopId)) {
    const tokens = await readEtsyTokens(db, shop.id);
    if (tokens) return new EtsyLiveClient(tokens, (t) => writeEtsyTokens(db, shop.id, t), shopId);
  }
  return new EtsyDryRunAdapter(random);
}

export type { EtsyAdapter } from "./types";
