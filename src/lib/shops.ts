import { and, asc, eq, sql } from "drizzle-orm";
import type { DB } from "@/db";
import { settings, shopAutomation, shopConnections, shops, type Shop, type ShopConnectionStatus, type ShopProvider } from "@/db/schema";
import { config, hasEtsyCredentials, hasPrintifyCredentials, storageBackend } from "@/lib/config";
import { effectivePublishMode } from "@/lib/publish-mode";
import { getSetting, setSetting, type EtsyTokens } from "@/lib/settings";

export const OMNISHOP_SLUG = "omnishop-ch";
export const ACTIVE_SHOP_COOKIE = "autopilot_shop";

/**
 * Kill switches:
 * - settings.automation.killSwitch is the global emergency stop. It pauses every shop.
 * - shops.kill_switch pauses only that shop.
 * The registry backfill never copies the global switch into shops.kill_switch.
 */

export function etsyShopIdFromEnv(value: string | undefined | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function isEtsyTokens(value: unknown): value is EtsyTokens {
  if (!value || typeof value !== "object") return false;
  const token = value as Partial<EtsyTokens>;
  return typeof token.accessToken === "string" && token.accessToken.length > 0 && typeof token.refreshToken === "string" && typeof token.expiresAt === "number";
}

function openRouterStatus(): ShopConnectionStatus {
  const base = config.openaiBaseUrl;
  if (config.openaiKey && base.includes("openrouter.ai")) return "connected";
  if (config.openaiKey) return "configured";
  return "missing";
}

export function connectionStatusPlan(etsyConnected: boolean, etsyShopId?: string | null): { provider: ShopProvider; status: ShopConnectionStatus; secretsRef: string }[] {
  const printify = config.printify;
  const printifyStatus: ShopConnectionStatus = hasPrintifyCredentials() ? "connected" : printify.token || printify.shopId ? "configured" : "missing";
  const storage = storageBackend();
  const storageStatus: ShopConnectionStatus = storage === "s3" ? "connected" : storage === "blob" ? "configured" : "missing";
  return [
    { provider: "etsy", status: etsyConnected ? "connected" : hasEtsyCredentials(etsyShopId ?? undefined) ? "configured" : "missing", secretsRef: "ETSY_" },
    { provider: "printify", status: printifyStatus, secretsRef: "PRINTIFY_" },
    { provider: "s3", status: storageStatus, secretsRef: "S3_" },
    { provider: "openrouter", status: openRouterStatus(), secretsRef: "OPENROUTER_" },
  ];
}

export async function resolveActiveShop(db: DB, requestedId?: string | null): Promise<Shop> {
  const rows = await db.select().from(shops).orderBy(asc(shops.createdAt));
  if (requestedId) {
    const found = rows.find((row) => row.id === requestedId);
    if (found) return found;
  }
  if (rows.length === 1) return rows[0];
  const omnishop = rows.find((row) => row.slug === OMNISHOP_SLUG);
  if (omnishop) return omnishop;
  throw new Error("No shop is registered");
}

/** Cookie when a request exists; otherwise the single-shop default. Jobs have no cookie. */
export async function resolveRequestShop(db: DB) {
  let requested: string | null = null;
  try {
    const { cookies } = await import("next/headers");
    requested = (await cookies()).get(ACTIVE_SHOP_COOKIE)?.value ?? null;
  } catch {
    requested = null;
  }
  return resolveActiveShop(db, requested);
}

export async function readEtsyTokens(db: DB, shopId: string): Promise<EtsyTokens | null> {
  const [row] = await db
    .select()
    .from(shopConnections)
    .where(and(eq(shopConnections.shopId, shopId), eq(shopConnections.provider, "etsy")));
  if (isEtsyTokens(row?.tokens)) return row.tokens;
  return getSetting(db, "etsyTokens");
}

/** Dual-write during the migration window so settings.etsyTokens and shop_connections stay readable. */
export async function writeEtsyTokens(db: DB, shopId: string, tokens: EtsyTokens, expected?: EtsyTokens): Promise<EtsyTokens | null> {
  if (expected) {
    const [row] = await db
      .select({ id: shopConnections.id, tokens: shopConnections.tokens })
      .from(shopConnections)
      .where(and(eq(shopConnections.shopId, shopId), eq(shopConnections.provider, "etsy")));
    if (row && isEtsyTokens(row.tokens)) {
      const [updated] = await db
        .update(shopConnections)
        .set({ tokens, status: "connected", updatedAt: new Date() })
        .where(
          and(
            eq(shopConnections.id, row.id),
            sql`${shopConnections.tokens}->>'accessToken' = ${expected.accessToken}`,
            sql`${shopConnections.tokens}->>'refreshToken' = ${expected.refreshToken}`,
          ),
        )
        .returning({ id: shopConnections.id });
      if (!updated) return (await readEtsyTokens(db, shopId)) ?? row.tokens;
      await db
        .update(settings)
        .set({ value: tokens, updatedAt: new Date() })
        .where(
          and(
            eq(settings.key, "etsyTokens"),
            sql`${settings.value}->>'accessToken' = ${expected.accessToken}`,
            sql`${settings.value}->>'refreshToken' = ${expected.refreshToken}`,
          ),
        );
      return tokens;
    }
    const [updated] = await db
      .update(settings)
      .set({ value: tokens, updatedAt: new Date() })
      .where(
        and(
          eq(settings.key, "etsyTokens"),
          sql`${settings.value}->>'accessToken' = ${expected.accessToken}`,
          sql`${settings.value}->>'refreshToken' = ${expected.refreshToken}`,
        ),
      )
      .returning({ key: settings.key });
    return updated ? tokens : readEtsyTokens(db, shopId);
  }
  await setSetting(db, "etsyTokens", tokens);
  const [row] = await db
    .select({ id: shopConnections.id })
    .from(shopConnections)
    .where(and(eq(shopConnections.shopId, shopId), eq(shopConnections.provider, "etsy")));
  if (row) {
    await db.update(shopConnections).set({ tokens, status: "connected", updatedAt: new Date() }).where(eq(shopConnections.id, row.id));
    return tokens;
  }
  await db.insert(shopConnections).values({
    shopId,
    provider: "etsy",
    status: "connected",
    secretsRef: "ETSY_",
    meta: {},
    tokens,
  });
  return tokens;
}

export type PublicShop = {
  id: string;
  slug: string;
  displayName: string;
  etsyShopId: string | null;
  etsyShopName: string | null;
  currency: string;
  locale: string;
  marketLocale: string | null;
  status: Shop["status"];
  publishMode: Shop["publishMode"];
  killSwitch: boolean;
  connections: { provider: ShopProvider; status: ShopConnectionStatus; secretsRef: string }[];
};

export async function listShopsPublic(db: DB): Promise<PublicShop[]> {
  const [rows, connections] = await Promise.all([
    db.select().from(shops).orderBy(asc(shops.createdAt)),
    db
      .select({
        shopId: shopConnections.shopId,
        provider: shopConnections.provider,
        status: shopConnections.status,
        secretsRef: shopConnections.secretsRef,
      })
      .from(shopConnections),
  ]);
  return rows.map((shop) => ({
    id: shop.id,
    slug: shop.slug,
    displayName: shop.displayName,
    etsyShopId: shop.etsyShopId,
    etsyShopName: shop.etsyShopName,
    currency: shop.currency,
    locale: shop.locale,
    marketLocale: shop.marketLocale,
    status: shop.status,
    publishMode: shop.publishMode,
    killSwitch: shop.killSwitch,
    connections: connections
      .filter((row) => row.shopId === shop.id)
      .map((row) => ({ provider: row.provider, status: row.status, secretsRef: row.secretsRef })),
  }));
}

/**
 * Idempotent OmniShop CH backfill. etsy_shop_id is copied from ETSY_SHOP_ID only when that env var is non-empty.
 * Does not store secret values. Does not create additional shops.
 */
export async function syncShopRegistry(db: DB) {
  const [existing] = await db.select().from(shops).where(eq(shops.slug, OMNISHOP_SLUG));
  if (!existing) return null;

  const automation = await getSetting(db, "automation");
  const stages = await getSetting(db, "stages");
  const legacyTokens = await getSetting(db, "etsyTokens");
  const publishMode = effectivePublishMode(automation.publishMode);
  const etsyShopId = etsyShopIdFromEnv(process.env.ETSY_SHOP_ID);
  const nextStatus = publishMode === "live" ? "live" : existing.status === "live" ? "dry-run" : existing.status;

  await db
    .update(shops)
    .set({
      displayName: "OmniShop CH",
      etsyShopName: "OmniShopByKaiArt",
      currency: existing.currency || "CHF",
      locale: existing.locale || "en",
      marketLocale: existing.marketLocale ?? "de-CH",
      ...(etsyShopId ? { etsyShopId } : {}),
      publishMode,
      status: nextStatus,
      updatedAt: new Date(),
    })
    .where(eq(shops.id, existing.id));

  await db
    .insert(shopAutomation)
    .values({ shopId: existing.id, automation, stages, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: shopAutomation.shopId,
      set: { automation, stages, updatedAt: new Date() },
    });

  const plan = connectionStatusPlan(Boolean(legacyTokens?.accessToken), existing.etsyShopId);
  for (const item of plan) {
    const [row] = await db
      .select()
      .from(shopConnections)
      .where(and(eq(shopConnections.shopId, existing.id), eq(shopConnections.provider, item.provider)));
    if (!row) {
      await db.insert(shopConnections).values({
        shopId: existing.id,
        provider: item.provider,
        status: item.status,
        secretsRef: item.secretsRef,
        meta: {},
        tokens: item.provider === "etsy" && legacyTokens ? legacyTokens : null,
      });
      continue;
    }
    const tokens = item.provider === "etsy" && !isEtsyTokens(row.tokens) && legacyTokens ? legacyTokens : row.tokens;
    await db
      .update(shopConnections)
      .set({
        status: item.provider === "etsy" && isEtsyTokens(tokens) ? "connected" : item.status,
        secretsRef: item.secretsRef,
        tokens,
        updatedAt: new Date(),
      })
      .where(eq(shopConnections.id, row.id));
  }

  const [shop] = await db.select().from(shops).where(eq(shops.id, existing.id));
  return shop ?? null;
}
