import { sql } from "drizzle-orm";
import type { DB } from "@/db";
export async function reliabilityStatus(db:DB) {
  const [jobs,heartbeats,uncertain]=await Promise.all([
    db.execute<{id:string;status:string;kind:string;error_code:string|null;updated_at:string}>(sql`select id,status,kind,error_code,updated_at from durable_jobs where status<>'completed' order by created_at limit 20`),
    db.execute<{key:string;seen_at:string}>(sql`select key,seen_at from worker_heartbeats`),
    db.execute<{count:number}>(sql`select count(*)::integer as count from operation_attempts where status in ('running','uncertain')`),
  ]);
  return {jobs:jobs.rows,heartbeats:heartbeats.rows,uncertain:Number(uncertain.rows[0]?.count??0)};
}
