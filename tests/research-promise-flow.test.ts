import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { keywords, listings } from "@/db/schema";
import { runStage } from "@/pipeline/runner";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("research-to-listing promise filtering", () => {
  it("does not select or list an Etsy Insights keyword promising a set of 3", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubEnv("ETSY_INSIGHTS_CSV", "keyword,search_volume,competition,niche\nswiss travel poster set of 3,1200,0.4,alpine");
    vi.stubEnv("RESEARCH_GOOGLE_TRENDS", "false");
    vi.stubEnv("ETSY_API_COMPETITION", "false");
    const client = new PGlite("memory://");
    try {
      const db = drizzle(client, { schema }) as DB;
      await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
      await db.insert(keywords).values({
        phrase: "swiss travel poster set of 3",
        niche: "alpine",
        source: "legacy-test",
        status: "selected",
      });
      const research = await runStage("research", "manual", { db, random: () => 0.2 });
      expect(research.status).toBe("success");
      expect(await db.select().from(keywords).where(eq(keywords.phrase, "swiss travel poster set of 3")))
        .toMatchObject([{ status: "rejected" }]);
      const listing = await runStage("listing", "manual", { db });
      expect(listing.summary).toContain("No new designs");
      expect(await db.select().from(listings)).toEqual([]);
    } finally {
      await client.close();
    }
  });
});
