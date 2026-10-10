import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setImageProviderForTests } from "@/adapters/image";
import { setLLMProviderForTests } from "@/adapters/llm";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { designs, keywords, listings } from "@/db/schema";
import { rgbPng } from "@/lib/png";
import { runStage } from "@/pipeline/runner";

const originalDemo = process.env.DEMO_MODE;
afterEach(() => {
  setImageProviderForTests(null);
  setLLMProviderForTests(null);
  if (originalDemo === undefined) delete process.env.DEMO_MODE;
  else process.env.DEMO_MODE = originalDemo;
});

describe("live visual gate", () => {
  it("retries twice with different seeds, records rejection, and never lists bad art", async () => {
    process.env.DEMO_MODE = "false";
    const client = new PGlite("memory://");
    try {
      const db = drizzle(client, { schema }) as DB;
      await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
      await db.insert(keywords).values({ phrase: "gothic floral shirt", niche: "gothic", source: "test", status: "selected", isDemo: false });
      const seeds: number[] = [];
      const image = `data:image/png;base64,${rgbPng(12, 18, [25, 25, 25]).toString("base64")}`;
      setImageProviderForTests({
        name: "test-image", estimatedCostChf: 0,
        generate: vi.fn(async (req) => {
          seeds.push(req.seed);
          return { url: image, costChf: 0, provider: "test-image" };
        }),
      });
      const assessImage = vi.fn(async () => ({
        score: 2, reasons: ["Empty black center"], text: true, empty: true, frameOnly: true, artifacts: false,
      }));
      setLLMProviderForTests({ name: "test-vision", assessImage, writeListing: vi.fn() });
      const result = await runStage("design", "manual", { db, random: () => 0.2 });
      expect(result.status).toBe("failed");
      expect(seeds).toEqual([200000000, 200000001, 200000002]);
      expect(assessImage).toHaveBeenCalledTimes(3);
      const [design] = await db.select().from(designs);
      expect(design.status).toBe("rejected");
      expect(design.qualityScore).toBe(2);
      expect(design.qualityReasons.join(" ")).toMatch(/signature|text|empty/i);
      await runStage("listing", "manual", { db });
      expect(await db.select().from(listings)).toHaveLength(0);
    } finally {
      await client.close();
    }
  });
});
