import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { DB } from "@/db";
import { OperationBusy } from "./operation-lease";

/** Persist intent BEFORE a non-idempotent provider call. Unknown outcomes require reconciliation. */
export async function providerAttempt<T>(db: DB, scope: string, input: unknown, dispatch: () => Promise<T>): Promise<T> {
  const key = `${scope}:${createHash("sha256").update(JSON.stringify(input)).digest("hex")}`;
  const claim = await db.execute(sql`insert into operation_attempts (key,input) values (${key},${JSON.stringify(input)}::jsonb) on conflict do nothing returning key`);
  if (!claim.rows.length) {
    const state = await db.execute<{status:string;result:T}>(sql`select status,result from operation_attempts where key=${key}`);
    if (state.rows[0]?.status === "completed") return state.rows[0].result;
    throw new OperationBusy();
  }
  try {
    const result = await dispatch();
    await db.execute(sql`update operation_attempts set status='completed',result=${JSON.stringify(result ?? null)}::jsonb,updated_at=now() where key=${key} and status='running'`);
    return result;
  } catch (error) {
    await db.execute(sql`update operation_attempts set status='uncertain',updated_at=now() where key=${key}`).catch(() => {});
    throw error;
  }
}
