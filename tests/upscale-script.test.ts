import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { designBriefs, designs } from "@/db/schema";
import { rgbPng } from "@/lib/png";
import { setUpscaleSessionForTests } from "@/pipeline/upscale";
import { upscaleDesigns } from "@/db/upscale-designs";

afterEach(() => {
  vi.unstubAllEnvs();
  setUpscaleSessionForTests(undefined);
});

describe("design upscale CLI", () => {
  it("previews actual output dimensions without writing the database or storage", async () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "");
    vi.stubEnv("AWS_ENDPOINT_URL_S3", "");
    vi.stubEnv("S3_BUCKET", "");
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    setUpscaleSessionForTests(null);
    const client = new PGlite("memory://");
    try {
      const db = drizzle(client, { schema }) as DB;
      await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
      const sourceUrl = `data:image/png;base64,${rgbPng(12, 18, [80, 100, 120]).toString("base64")}`;
      const [keyword] = await db.insert(schema.keywords).values({
        phrase: "test alpine print", niche: "alpine", source: "test",
      }).returning();
      await db.insert(designBriefs).values({
        keywordId: keyword.id,
        niche: "alpine",
        prompt: "test",
        productType: "digital",
        dayKey: "2026-10-17",
      });
      const [design] = await db.insert(designs).values({
        keywordId: keyword.id,
        niche: "alpine",
        prompt: "test",
        provider: "test",
        imageUrl: sourceUrl,
        status: "generated",
      }).returning();

      const [preview] = await upscaleDesigns(db, [design.id]);

      expect(preview).toMatchObject({
        mode: "preview",
        upscaleMethod: "lanczos",
        sourcePx: { width: 12, height: 18 },
        outputPx: { width: 1365, height: 2048 },
      });
      expect((await db.select().from(designs))[0]).toMatchObject({
        imageUrl: sourceUrl,
        sourcePx: null,
        outputPx: null,
      });
    } finally {
      await client.close();
    }
  });
});
