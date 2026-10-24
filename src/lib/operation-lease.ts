import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { DB } from "@/db";

const heldKeys = new AsyncLocalStorage<Set<string>>();
const context = new AsyncLocalStorage<() => Promise<void>>();
export const assertExecutionLease = async () => { await context.getStore()?.(); };
export class OperationBusy extends Error { constructor() { super("Operation already running or awaiting reconciliation"); } }

/** Database lease, renewed while alive. Owner tokens fence every renewal and release. */
export async function withOperationLease<T>(db: DB, key: string, work: () => Promise<T>, ttlMs = 90_000): Promise<T> {
  const held=heldKeys.getStore();
  if(held?.has(key)) { await assertExecutionLease(); return work(); }
  const owner = randomUUID();
  const acquired = await db.execute<{ owner: string }>(sql`
    insert into operation_leases (key, owner, expires_at) values (${key}, ${owner}, now() + ${ttlMs} * interval '1 millisecond')
    on conflict (key) do update set owner = excluded.owner, expires_at = excluded.expires_at
    where operation_leases.expires_at < now() returning owner
  `);
  if (!acquired.rows.length) throw new OperationBusy();
  const parent = context.getStore();
  const check = async () => {
    await parent?.();
    const live = await db.execute(sql`select key from operation_leases where key=${key} and owner=${owner} and expires_at > now()`);
    if (!live.rows.length) throw new Error("Execution lease lost; operation stopped before dispatch");
  };
  const heartbeat = setInterval(() => {
    void db.execute(sql`update operation_leases set expires_at=now() + ${ttlMs} * interval '1 millisecond' where key=${key} and owner=${owner} and expires_at > now()`).catch(() => {});
  }, Math.floor(ttlMs / 3));
  heartbeat.unref();
  try { return await heldKeys.run(new Set([...(held??[]),key]),()=>context.run(check, work)); }
  finally {
    clearInterval(heartbeat);
    await db.execute(sql`delete from operation_leases where key=${key} and owner=${owner}`).catch(() => {});
  }
}
