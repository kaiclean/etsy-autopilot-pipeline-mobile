import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { DB } from "@/db";
import type { StageName } from "@/pipeline/types";

export const STAGE_LEASE_MS = 120_000;
export const STAGE_HEARTBEAT_MS = 30_000;
export type StageLease = { owner: string; stage: StageName; shopId: string };

/** A fenced row lease survives HTTP connection changes; it is never re-entrant. */
export async function acquireStageLock(db: DB, stage: StageName, shopId: string): Promise<StageLease | null> {
  const lease = { owner: randomUUID(), stage, shopId };
  const result = await db.execute(sql`
    INSERT INTO runtime_stage_leases(shop_id,stage,owner,expires_at)
    VALUES (${shopId}::uuid,${stage},${lease.owner}::uuid,now()+interval '120 seconds')
    ON CONFLICT (shop_id,stage) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at
    WHERE runtime_stage_leases.expires_at < now()
    RETURNING owner
  `);
  return result.rows.length ? lease : null;
}

export async function renewStageLock(db: DB, lease: StageLease): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE runtime_stage_leases SET expires_at=now()+interval '120 seconds'
    WHERE shop_id=${lease.shopId}::uuid AND stage=${lease.stage} AND owner=${lease.owner}::uuid AND expires_at>now()
    RETURNING owner
  `);
  return result.rows.length > 0;
}

export async function releaseStageLock(db: DB, lease: StageLease): Promise<void> {
  await db.execute(sql`DELETE FROM runtime_stage_leases WHERE shop_id=${lease.shopId}::uuid AND stage=${lease.stage} AND owner=${lease.owner}::uuid`);
}
