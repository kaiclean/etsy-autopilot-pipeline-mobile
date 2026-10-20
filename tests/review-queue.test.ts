import { describe, expect, it } from "vitest";
import { repeatedTagWords } from "@/lib/review-queue";

describe("review queue", () => {
  it("reports words repeated across tags", () => {
    expect(repeatedTagWords(["christmas cabin", "cabin print", "snow"])).toEqual({ cabin: 2 });
    expect(repeatedTagWords(["a b", "c d"])).toEqual({});
  });
});

import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { DB } from "@/db";
import { listingsForDesigns } from "@/lib/review-queue";

describe("listings by design", () => {
  it("returns every status with its Etsy and activation fields", async () => {
    const client = new PGlite("memory://");
    const db = drizzle(client, { schema }) as DB;
    await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
    const [d] = await db.insert(schema.designs).values({ niche: "alpine", prompt: "p", provider: "x", imageUrl: "https://e/a.png" }).returning();
    await db.insert(schema.listings).values({ designId: d.id, niche: "alpine", productType: "digital", title: "t", tags: [], description: "d", imageUrl: "https://e/a.png", priceChf: 3.9, netChf: 2, marginPct: 55, status: "published", etsyListingId: "123" });
    const rows = await listingsForDesigns(db, [d.id]);
    expect(rows).toEqual([expect.objectContaining({ status: "published", etsyListingId: "123", activatedAt: null })]);
    await client.close();
  });
});
