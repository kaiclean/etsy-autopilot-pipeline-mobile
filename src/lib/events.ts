import { eq, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { DB } from "@/db";
import { events } from "@/db/schema";
import { isDemoMode } from "./config";
import { dispatchEventPush } from "./push";

export type EmitInput = {
  type: string;
  title: string;
  body?: string;
  severity?: "info" | "success" | "warning" | "error";
  href?: string;
  shopId?: string;
};

export async function emit(db: DB, e: EmitInput, demo = isDemoMode(), opts?: { push?: boolean }) {
  const { shopId, ...rest } = e;
  await db.insert(events).values({
    ...rest,
    ...(shopId ? { shopId } : {}),
    severity: rest.severity ?? "info",
    isDemo: demo,
  });
  if (opts?.push === false) return;
  try {
    await dispatchEventPush(db, e);
  } catch (error) {
    console.error("[web-push] dispatch failed", error instanceof Error ? error.message : error);
  }
}

/** In live mode, seeded/mock rows (isDemo=true) are hidden everywhere. */
export function visible(col: PgColumn): SQL | undefined {
  return isDemoMode() ? undefined : eq(col, false);
}
