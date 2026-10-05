import type { PublishMode } from "@/lib/publish-mode";

/** Cockpit label. The public seller line stays in the shell footer. */
export const OMNISHOP_DISPLAY_NAME = "OmniShop CH";
export const OMNISHOP_HANDLE = "OmniShopByKaiArt";

export type ShopIdentity = {
  displayName: string;
  handle: string;
  /** Numeric Etsy shop id, or an em dash when ETSY_SHOP_ID is unset. */
  shopIdLabel: string;
  publishMode: PublishMode;
  killSwitch: boolean;
  /** Short public host, desktop only. Null when the host is not exposed. */
  host: string | null;
};

function trim(value: string | undefined) {
  const next = value?.trim();
  return next ? next : undefined;
}

/** First DNS label, so a Railway hostname stays short in the strip. */
export function shortHost(raw: string | undefined): string | null {
  const value = trim(raw);
  if (!value) return null;
  const withoutProtocol = value.replace(/^[a-z]+:\/\//i, "").split("/")[0] ?? "";
  const host = withoutProtocol.split(":")[0]?.trim();
  if (!host) return null;
  const label = host.split(".")[0];
  return label || host;
}

export type ShopIdentityEnv = {
  ETSY_SHOP_ID?: string;
  RAILWAY_PUBLIC_DOMAIN?: string;
  RAILWAY_STATIC_URL?: string;
  APP_URL?: string;
  [key: string]: string | undefined;
};

export function railwayHostShort(env: ShopIdentityEnv = process.env): string | null {
  return shortHost(env.RAILWAY_PUBLIC_DOMAIN) ?? shortHost(env.RAILWAY_STATIC_URL) ?? shortHost(env.APP_URL);
}

/**
 * Shop id comes only from the environment (or, in M1, a shop row passed in).
 * An empty value stays an em dash. This function does not invent an id.
 */
export function buildShopIdentity(input: {
  publishMode: PublishMode;
  killSwitch: boolean;
  etsyShopId?: string | null;
  displayName?: string;
  handle?: string;
  env?: ShopIdentityEnv;
}): ShopIdentity {
  const env = input.env ?? process.env;
  const fromEnv = trim(env.ETSY_SHOP_ID);
  const explicit = trim(input.etsyShopId ?? undefined);
  const shopId = explicit ?? fromEnv;
  return {
    displayName: input.displayName?.trim() || OMNISHOP_DISPLAY_NAME,
    handle: input.handle?.trim() || OMNISHOP_HANDLE,
    shopIdLabel: shopId ?? "—",
    publishMode: input.publishMode === "live" ? "live" : "dry-run",
    killSwitch: input.killSwitch,
    host: railwayHostShort(env),
  };
}
