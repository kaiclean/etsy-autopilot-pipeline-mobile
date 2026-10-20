import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";

let client: PGlite | null = null;
import { designs, listings } from "@/db/schema";
import { flagRedesign, pendingUpscaleJobs, redesignQueue, type NeedsDesignRow } from "@/lib/upscale-jobs";

async function freshDb() {
  client = new PGlite("memory://");
  const db = drizzle(client, { schema }) as DB;
  await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  return db;
}
afterEach(async () => { await client?.close(); client = null; });

describe("full-size redesign flag", () => {
  it("flags a 1024px design used for an A3 poster, once, and lists it for Design with its prompt", async () => {
    const db = await freshDb();
    const [d] = await db.insert(designs).values({ niche: "alpine", prompt: "christmas cabin, vintage", provider: "cloudflare", imageUrl: "https://cdn.example/a.png", imageWidth: 1024, imageHeight: 1024, upscaleMethod: "lanczos", sourcePx: { width: 1024, height: 1024 } }).returning();
    await db.insert(listings).values({ designId: d.id, niche: "alpine", productType: "pod", podProvider: "printify:posterA3", title: "t", tags: [], description: "d", imageUrl: "https://cdn.example/a.png", priceChf: 30, netChf: 9, marginPct: 30 });
    const needs: NeedsDesignRow[] = [];
    const jobs = await pendingUpscaleJobs(db, 5, needs);
    expect(jobs).toHaveLength(0);
    expect(needs.map((row) => row.designId)).toEqual([d.id]);
    expect(await flagRedesign(db, needs[0]!)).toBe(false); // already flagged by the job list
    const queue = await redesignQueue(db);
    expect(queue).toHaveLength(1);
    expect(queue[0]!.prompt).toBe("christmas cabin, vintage");
    expect(queue[0]!.flag?.reason).toMatch(/1024×1024 needs 4\.84×/);
  });
});
