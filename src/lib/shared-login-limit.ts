import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { DB } from "@/db";
/** Global cap works across replicas and cannot be bypassed by spoofing forwarded headers. */
export async function takeLoginAttempt(db:DB) {
  const key=createHash('sha256').update('dashboard-login').digest('hex');
  const result=await db.execute(sql`
    insert into login_attempts (key,failures) values (${key},1)
    on conflict (key) do update set failures=case when login_attempts.window_start<now()-interval '15 minutes' then 1 else login_attempts.failures+1 end,
      window_start=case when login_attempts.window_start<now()-interval '15 minutes' then now() else login_attempts.window_start end
    where login_attempts.window_start<now()-interval '15 minutes' or login_attempts.failures<32 returning key
  `);
  return result.rows.length>0;
}
