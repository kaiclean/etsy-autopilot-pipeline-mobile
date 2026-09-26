import { eq, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { DB } from "@/db";
import { events } from "@/db/schema";
import { isDemoMode } from "./config";

export type EmitInput = {
  type: string;
  title: string;
  body?: string;
  severity?: "info" | "success" | "warning" | "error";
  href?: string;
};

export async function emit(db: DB, e: EmitInput) {
  await db.insert(events).values({ ...e, severity: e.severity ?? "info", isDemo: isDemoMode() });
}

/** In live mode, seeded/mock rows (isDemo=true) are hidden everywhere. */
export function visible(col: PgColumn): SQL | undefined {
  return isDemoMode() ? undefined : eq(col, false);
}
