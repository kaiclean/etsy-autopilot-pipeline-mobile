import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { CLOUDFLARE_IMAGES_PER_DAY, MAX_REDESIGNS_PER_DAY, quotaUsed, reserveImage } from "@/lib/image-quota";

async function freshDb() {
  const db = drizzle(new PGlite("memory://"), { schema }) as unknown as DB;
  await migrate(db as never, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  return db;
}
const now = new Date("2026-10-20T05:00:00Z");

describe("image quota", () => {
  it("concurrent reservations never exceed the shared Cloudflare cap", async () => {
    const db = await freshDb();
    const results = await Promise.all(Array.from({ length: CLOUDFLARE_IMAGES_PER_DAY + 7 }, (_, i) =>
      reserveImage(db, { provider: "cloudflare", redesign: i % 2 === 0, now })));
    expect(results.filter((r) => r.ok).length).toBe(CLOUDFLARE_IMAGES_PER_DAY);
    expect(await quotaUsed(db, "cloudflare:2026-10-20")).toBe(CLOUDFLARE_IMAGES_PER_DAY);
    expect(await quotaUsed(db, "redesign:2026-10-20")).toBeLessThanOrEqual(MAX_REDESIGNS_PER_DAY);
  });
  it("redesigns stop at 5/day and daily runs share the Cloudflare count", async () => {
    const db = await freshDb();
    for (let i = 0; i < MAX_REDESIGNS_PER_DAY; i++) expect((await reserveImage(db, { provider: "cloudflare", redesign: true, now })).ok).toBe(true);
    expect((await reserveImage(db, { provider: "cloudflare", redesign: true, now })).ok).toBe(false);
    for (let i = MAX_REDESIGNS_PER_DAY; i < CLOUDFLARE_IMAGES_PER_DAY; i++) expect((await reserveImage(db, { provider: "cloudflare", now })).ok).toBe(true);
    expect(await reserveImage(db, { provider: "cloudflare", now })).toMatchObject({ ok: false });
    expect((await reserveImage(db, { provider: "cloudflare", now: new Date("2026-10-21T05:00:00Z") })).ok).toBe(true);
  });
});
