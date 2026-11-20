import { is } from "drizzle-orm";
import { NeonHttpDatabase } from "drizzle-orm/neon-http";
import { config } from "@/lib/config";
import type { DB } from "./index";
import * as schema from "./schema";

export async function withDbTransaction<T>(db: DB, run: (tx: DB) => Promise<T>): Promise<T> {
  if (!is(db, NeonHttpDatabase)) return db.transaction(run);

  // The HTTP driver cannot run interactive transactions. Keep the WebSocket
  // connection scoped to this request (including on serverless hosts).
  const { Pool } = await import("@neondatabase/serverless");
  const { drizzle } = await import("drizzle-orm/neon-serverless");
  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    return await drizzle(pool, { schema }).transaction((tx) => run(tx as unknown as DB));
  } finally {
    await pool.end();
  }
}
