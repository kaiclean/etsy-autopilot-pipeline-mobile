import { neon } from "@neondatabase/serverless";
import journal from "../../drizzle/meta/_journal.json";

export async function warnMissingJournalEntries(url: string) {
  try {
    const query = neon(url);
    const rows = await query.query("SELECT created_at FROM drizzle.__drizzle_migrations", [], {
      fetchOptions: { signal: AbortSignal.timeout(5_000) },
    });
    // The highest timestamp can hide gaps; compare every entry, not just the head.
    const applied = new Set(rows.map((row) => Number(row.created_at)));
    const missing = journal.entries.filter((entry) => !applied.has(entry.when));
    if (missing.length) {
      console.warn(`Neon migration check: missing journal entries in drizzle.__drizzle_migrations: ${missing.map((entry) => entry.tag).join(", ")}`);
    }
  } catch {
    // Do not block startup or log connection details.
    console.warn("Neon migration check: could not read drizzle.__drizzle_migrations");
  }
}
