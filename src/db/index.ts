import path from "node:path";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "./schema";
import { config } from "@/lib/config";

export type DB = PgliteDatabase<typeof schema>;

type Holder = { db?: DB; ready?: Promise<DB> };
const g = globalThis as unknown as { __etsyAutopilotDb?: Holder };
const holder: Holder = (g.__etsyAutopilotDb ??= {});

const migrationsFolder = path.join(process.cwd(), "drizzle");

function pgliteDir() {
  if (process.env.PGLITE_DIR) return process.env.PGLITE_DIR;
  if (process.env.VERCEL) return "/tmp/etsy-autopilot-pglite";
  return path.join(process.cwd(), ".data", "pglite");
}

async function connect(): Promise<DB> {
  const url = config.databaseUrl;
  if (url) {
    const { neon } = await import("@neondatabase/serverless");
    const { drizzle } = await import("drizzle-orm/neon-http");
    const { migrate } = await import("drizzle-orm/neon-http/migrator");
    const db = drizzle(neon(url), { schema });
    await migrate(db, { migrationsFolder });
    const { syncShopRegistry } = await import("@/lib/shops");
    await syncShopRegistry(db as unknown as DB);
    // Query-builder API is identical across drivers; unify the type.
    return db as unknown as DB;
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const dir = pgliteDir();
  if (!dir.startsWith("memory://")) {
    const fs = await import("node:fs");
    fs.mkdirSync(dir, { recursive: true });
  }
  const client = new PGlite(dir);
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
  const { syncShopRegistry } = await import("@/lib/shops");
  await syncShopRegistry(db);
  return db;
}

/** Connects, migrates and (in demo mode, on an empty DB) seeds. Memoized per process. */
export function getDb(): Promise<DB> {
  if (holder.db) return Promise.resolve(holder.db);
  holder.ready ??= (async () => {
    const db = await connect();
    const { seedIfEmpty } = await import("./seed");
    await seedIfEmpty(db);
    holder.db = db;
    return db;
  })().catch((err) => {
    holder.ready = undefined;
    throw err;
  });
  return holder.ready;
}

export { schema };
