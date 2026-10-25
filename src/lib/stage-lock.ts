import type { DB } from "@/db";
import { StageName } from "@/pipeline/types";

/**
 * PostgreSQL advisory lock for cross-replica stage exclusivity.
 * Uses 64-bit key derived from stage name + shop ID.
 * Lock is session-level (released on transaction end or explicit unlock).
 */
export async function acquireStageLock(
  db: DB,
  stage: StageName,
  shopId: string,
): Promise<boolean> {
  // Generate deterministic 64-bit key: hash(stage + shopId) mod 2^63
  const str = `${stage}:${shopId}`;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  // advisory_lock uses int8 (signed 64-bit); ensure positive
  const key = BigInt((hash >>> 0) & 0x7fffffffffffffff);
  const result = await db.execute(
    `SELECT pg_try_advisory_lock(${key}) as acquired`,
  );
  return (result.rows[0]?.acquired as boolean) ?? false;
}

export async function releaseStageLock(
  db: DB,
  stage: StageName,
  shopId: string,
): Promise<void> {
  const str = `${stage}:${shopId}`;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  const key = BigInt((hash >>> 0) & 0x7fffffffffffffff);
  await db.execute(`SELECT pg_advisory_unlock(${key})`);
}