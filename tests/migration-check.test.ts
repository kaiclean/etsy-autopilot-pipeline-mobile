import { afterEach, expect, it, vi } from "vitest";
import journal from "../drizzle/meta/_journal.json";
import { warnMissingJournalEntries } from "@/db/migration-check";

const query = vi.hoisted(() => vi.fn());
vi.mock("@neondatabase/serverless", () => ({ neon: () => ({ query }) }));

afterEach(() => {
  vi.restoreAllMocks();
  query.mockReset();
});

it("reports journal gaps even when the Neon ledger has a newer row", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  query.mockResolvedValue([
    ...journal.entries.slice(0, -2).map((entry) => ({ created_at: String(entry.when) })),
    { created_at: "1793410867943" },
  ]);
  await warnMissingJournalEntries("postgres://unused");
  expect(query).toHaveBeenCalledWith("SELECT created_at FROM drizzle.__drizzle_migrations", [], expect.any(Object));
  expect(warn).toHaveBeenCalledOnce();
  expect(warn.mock.calls[0][0]).toContain("0034_brain_product_origins, 0035_brain_live_vault");
});

it("is quiet for a complete ledger and warns without leaking query errors", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  query.mockResolvedValueOnce(journal.entries.map((entry) => ({ created_at: String(entry.when) })));
  await warnMissingJournalEntries("postgres://unused");
  expect(warn).not.toHaveBeenCalled();
  query.mockRejectedValueOnce(new Error("private connection details"));
  await warnMissingJournalEntries("postgres://unused");
  expect(warn).toHaveBeenCalledWith("Neon migration check: could not read drizzle.__drizzle_migrations");
});
