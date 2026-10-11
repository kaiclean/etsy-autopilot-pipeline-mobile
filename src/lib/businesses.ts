import { asc, eq } from "drizzle-orm";
import type { DB } from "@/db";
import { shops, type BusinessConfig, type Shop, type ShopStatus } from "@/db/schema";
import { GO_LIVE_CONFIRMATION } from "@/lib/publish-mode";
import { businessDailyAiCap, businessNumberFrom } from "@/lib/spend-cap";

/** Every inserted business starts here. Live is a later CONFIRM, never an insert default. */
export const NEW_BUSINESS = {
  status: "dry-run" as const,
  publishMode: "dry-run" as const,
  killSwitch: false,
};

const ENABLED: ShopStatus[] = ["draft", "connecting", "dry-run", "live"];

export function isEnabledBusiness(status: string) {
  return (ENABLED as string[]).includes(status);
}

export function businessesForCron<T extends { slug: string; status: string }>(rows: T[], slug: string | null) {
  if (slug) return rows.filter((row) => row.slug === slug);
  return rows.filter((row) => isEnabledBusiness(row.status));
}

export function businessGoLiveDecision(input: { mode: string; confirmation?: string }):
  | { ok: true; mode: "dry-run" | "live" }
  | { ok: false; error: string } {
  if (input.mode === "dry-run") return { ok: true, mode: "dry-run" };
  if (input.mode !== "live") return { ok: false, error: "Unknown publish mode." };
  if (input.confirmation !== GO_LIVE_CONFIRMATION) {
    return { ok: false, error: `Type ${GO_LIVE_CONFIRMATION} to go live.` };
  }
  return { ok: true, mode: "live" };
}

export async function insertBusiness(
  db: DB,
  input: { slug: string; displayName: string; kind: string; parentId?: string | null; config?: BusinessConfig },
) {
  const [row] = await db
    .insert(shops)
    .values({
      slug: input.slug,
      displayName: input.displayName,
      kind: input.kind,
      parentId: input.parentId ?? null,
      config: input.config ?? {},
      ...NEW_BUSINESS,
    })
    .returning();
  return row;
}

export async function applyBusinessPublishMode(
  db: DB,
  id: string,
  mode: string,
  confirmation = "",
): Promise<{ ok: true; publishMode: "dry-run" | "live" } | { ok: false; error: string }> {
  const decision = businessGoLiveDecision({ mode, confirmation });
  if (!decision.ok) return decision;
  const [shop] = await db.select().from(shops).where(eq(shops.id, id));
  if (!shop) return { ok: false, error: "Unknown business." };
  if (shop.kind === "etsy") {
    return { ok: false, error: "Etsy go-live stays on Connections." };
  }
  await db
    .update(shops)
    .set({
      publishMode: decision.mode,
      status: decision.mode === "live" ? "live" : "dry-run",
      updatedAt: new Date(),
    })
    .where(eq(shops.id, id));
  return { ok: true, publishMode: decision.mode };
}

export async function applyBusinessKillSwitch(db: DB, id: string, on: boolean) {
  const [shop] = await db.select({ id: shops.id }).from(shops).where(eq(shops.id, id));
  if (!shop) return { ok: false as const, error: "Unknown business." };
  await db.update(shops).set({ killSwitch: on, updatedAt: new Date() }).where(eq(shops.id, id));
  return { ok: true as const, killSwitch: on };
}

export function configWithCap(config: unknown, cap: number | null): BusinessConfig {
  const base = config && typeof config === "object" && !Array.isArray(config) ? { ...(config as BusinessConfig) } : {};
  if (cap == null) {
    delete base.dailyAiCapChf;
    return base;
  }
  return { ...base, dailyAiCapChf: cap };
}

export async function applyBusinessSpendCap(db: DB, id: string, cap: number | null) {
  if (cap != null && (!Number.isFinite(cap) || cap < 0)) return { ok: false as const, error: "Spend cap must be zero or more." };
  const [shop] = await db.select().from(shops).where(eq(shops.id, id));
  if (!shop) return { ok: false as const, error: "Unknown business." };
  await db.update(shops).set({ config: configWithCap(shop.config, cap), updatedAt: new Date() }).where(eq(shops.id, id));
  return { ok: true as const };
}

export type BusinessCard = {
  id: string;
  slug: string;
  displayName: string;
  kind: string;
  parentId: string | null;
  parentName: string | null;
  status: Shop["status"];
  publishMode: Shop["publishMode"];
  killSwitch: boolean;
  dailyAiCapChf: number | null;
  businessNumber: number | null;
  active: boolean;
};

export async function listBusinessCards(db: DB, activeId: string | null): Promise<BusinessCard[]> {
  const rows = await db.select().from(shops).orderBy(asc(shops.createdAt));
  const names = new Map(rows.map((row) => [row.id, row.displayName]));
  return rows.map((row) => {
    const explicit = businessDailyAiCap(row.config, Number.NaN);
    const hasOwnCap = row.config && typeof row.config === "object" && typeof (row.config as BusinessConfig).dailyAiCapChf === "number";
    return {
      id: row.id,
      slug: row.slug,
      displayName: row.displayName,
      kind: row.kind,
      parentId: row.parentId,
      parentName: row.parentId ? names.get(row.parentId) ?? null : null,
      status: row.status,
      publishMode: row.publishMode,
      killSwitch: row.killSwitch,
      dailyAiCapChf: hasOwnCap ? explicit : null,
      businessNumber: businessNumberFrom(row.config),
      active: row.id === activeId,
    };
  });
}
