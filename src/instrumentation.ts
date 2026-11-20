import { PHASE_PRODUCTION_BUILD } from "next/constants";

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NODE_ENV !== "production" || process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD) return;
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return;
  const { warnMissingJournalEntries } = await import("./db/migration-check");
  await warnMissingJournalEntries(url);
}
