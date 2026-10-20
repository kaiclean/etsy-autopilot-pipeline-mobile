import { and, eq, lt, sql } from "drizzle-orm";
import type { DB } from "@/db";
import { imageQuota } from "@/db/schema";

/** Cloudflare Workers AI free tier: 10,000 neurons/day ÷ ~1,000 per image. Shared by daily runs and redesigns. */
export const CLOUDFLARE_IMAGES_PER_DAY = Number(process.env.CLOUDFLARE_IMAGES_PER_DAY ?? 10);
export const MAX_REDESIGNS_PER_DAY = 5;

const day = (now: Date) => now.toISOString().slice(0, 10);

/**
 * Atomically take one slot under `cap` for `key`. One INSERT … ON CONFLICT DO UPDATE … WHERE used < cap:
 * the conflicting row is locked, so two concurrent callers cannot both pass the last slot.
 */
async function take(db: DB, key: string, cap: number) {
  if (cap <= 0) return false;
  const rows = await db.insert(imageQuota).values({ key, used: 1 })
    .onConflictDoUpdate({ target: imageQuota.key, set: { used: sql`${imageQuota.used} + 1`, updatedAt: new Date() }, setWhere: lt(imageQuota.used, cap) })
    .returning({ used: imageQuota.used });
  return rows.length > 0;
}

async function giveBack(db: DB, key: string) {
  await db.update(imageQuota).set({ used: sql`greatest(${imageQuota.used} - 1, 0)` }).where(and(eq(imageQuota.key, key)));
}

export async function quotaUsed(db: DB, key: string) {
  const [row] = await db.select({ used: imageQuota.used }).from(imageQuota).where(eq(imageQuota.key, key));
  return row?.used ?? 0;
}

/** Reserve one Cloudflare image (and, for redesigns, one redesign slot). Returns null when a cap is reached. */
export async function reserveImage(db: DB, opts: { provider: string; redesign?: boolean; now?: Date }) {
  const d = day(opts.now ?? new Date());
  const cfKey = opts.provider.includes("cloudflare") ? `cloudflare:${d}` : null;
  const rdKey = opts.redesign ? `redesign:${d}` : null;
  if (rdKey && !(await take(db, rdKey, MAX_REDESIGNS_PER_DAY))) return { ok: false as const, reason: `redesign cap ${MAX_REDESIGNS_PER_DAY}/day reached` };
  if (cfKey && !(await take(db, cfKey, CLOUDFLARE_IMAGES_PER_DAY))) {
    if (rdKey) await giveBack(db, rdKey);
    return { ok: false as const, reason: `Cloudflare image cap ${CLOUDFLARE_IMAGES_PER_DAY}/day reached` };
  }
  return { ok: true as const, keys: [cfKey, rdKey].filter(Boolean) as string[] };
}
