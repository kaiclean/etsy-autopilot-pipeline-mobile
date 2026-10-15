import type { DB } from "@/db";
import { config, hasEtsyCredentials } from "@/lib/config";
import { liveWritesEnabled } from "@/lib/read-publish-mode";
import { OMNISHOP_SLUG, readEtsyTokens, resolveActiveShop, writeEtsyTokens } from "@/lib/shops";
import { EtsyLiveClient } from "./client";
import { EtsyDryRunAdapter } from "./dryrun";
import { withEtsyRefreshLease } from "./refresh-lock";
import type { EtsyAdapter } from "./types";

/**
 * Reads use the live shop whenever credentials and OAuth tokens exist.
 * Writes also need the dashboard confirmation and host PUBLISH_MODE=live.
 * Shop id and tokens prefer the shop row, then settings.etsyTokens, then ETSY_SHOP_ID.
 */
export async function getEtsyAdapter(db: DB, random?: () => number, intent: "read" | "write" = "write", requestedShopId?: string): Promise<EtsyAdapter> {
  const shop = await resolveActiveShop(db, requestedShopId);
  if (requestedShopId && shop.id !== requestedShopId) throw new Error("Etsy shop is not registered");
  const shopId = shop.etsyShopId?.trim() || (shop.slug === OMNISHOP_SLUG ? config.etsy.shopId : undefined);
  const allowed = intent === "read" || (await liveWritesEnabled(db));
  if (allowed && hasEtsyCredentials(shopId)) {
    const tokens = await readEtsyTokens(db, shop.id);
    if (tokens) return new EtsyLiveClient(
      tokens, (t, expected) => writeEtsyTokens(db, shop.id, t, expected), shopId,
      () => readEtsyTokens(db, shop.id), (work) => withEtsyRefreshLease(db, shop.id, work),
    );
  }
  return new EtsyDryRunAdapter(random);
}

export type { EtsyAdapter } from "./types";
