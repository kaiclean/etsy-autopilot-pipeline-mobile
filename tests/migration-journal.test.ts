import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";

it("journals every SQL migration exactly once with ordered indexes and timestamps", async () => {
  const folder = path.join(process.cwd(), "drizzle");
  const files = (await readdir(folder)).filter((file) => file.endsWith(".sql")).sort();
  const journal = JSON.parse(await readFile(path.join(folder, "meta/_journal.json"), "utf8")) as {
    entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
  };
  expect(journal.entries.map((entry) => `${entry.tag}.sql`)).toEqual(files);
  journal.entries.forEach((entry, index) => {
    expect(entry).toMatchObject({ idx: index, version: "7", breakpoints: true });
    expect(entry.when).toBeGreaterThan(index ? journal.entries[index - 1].when : 0);
  });
});
