import path from "node:path";
import { eq, getTableColumns, sql } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { designs, listings, orders } from "@/db/schema";
import {
  applyStoredImageUrls,
  compactImageUrlSql,
  containsInlineImage,
  displayImageUrlSql,
  extractInlineDataUrl,
  persistableImageUrl,
  replacePreviewSrc,
} from "@/lib/compact-image-url";
import { backfillInlineImages, readTextColumn } from "@/lib/image-backfill";
import { analyticsListingsQuery, ordersListQuery } from "@/lib/queries";
import { digitalPreviewUrl } from "@/lib/png";

const ENV_KEYS = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_ENDPOINT_URL_S3", "S3_BUCKET", "BLOB_READ_WRITE_TOKEN"] as const;
const original = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreEnv() {
  for (const key of ENV_KEYS) {
    const value = original[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  restoreEnv();
});

async function memoryDb() {
  const client = new PGlite("memory://");
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  return db as unknown as DB;
}

function dataUrl(token: string) {
  return `data:image/png;base64,${"A".repeat(4000)}${token}${"B".repeat(4000)}`;
}

describe("inline image urls", () => {
  it("keeps a short preview src and drops a data URL", () => {
    expect(digitalPreviewUrl("/api/placeholder/7?niche=alpine", "alpine")).toBe(
      "/api/preview?niche=alpine&src=%2Fapi%2Fplaceholder%2F7%3Fniche%3Dalpine",
    );
    const inline = digitalPreviewUrl(dataUrl("HIDDEN"), "gothic");
    expect(inline).toBe("/api/preview?niche=gothic");
    expect(inline).not.toContain("HIDDEN");
    expect(containsInlineImage(dataUrl("X"))).toBe(true);
    expect(extractInlineDataUrl(`/api/preview?niche=alpine&src=${encodeURIComponent(dataUrl("SRC"))}`)).toContain("SRC");
  });

  it("rewrites a shared data URL so the gallery and delivery file differ", () => {
    const raw = dataUrl("SAME");
    const stored = "https://cdn.example/designs/art.png";
    const next = applyStoredImageUrls({
      imageUrl: raw,
      deliveryUrl: raw,
      niche: "alpine",
      storedByDataUrl: new Map([[raw, stored]]),
    });
    expect(next.deliveryUrl).toBe(stored);
    expect(next.imageUrl).toContain("/api/preview?");
    expect(next.imageUrl).toContain(encodeURIComponent(stored));
    expect(next.imageUrl).not.toContain("SAME");
    expect(next.imageUrl).not.toBe(next.deliveryUrl);

    const embedded = `/api/preview?niche=christmas&src=${encodeURIComponent(raw)}`;
    const replaced = replacePreviewSrc(embedded, stored);
    expect(replaced).toBe(`/api/preview?niche=christmas&src=${encodeURIComponent(stored)}`);
    expect(replaced).not.toContain("SAME");
  });

  it("refuses to persist a data URL unless storage uploads it", async () => {
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_ENDPOINT_URL_S3;
    delete process.env.S3_BUCKET;
    delete process.env.BLOB_READ_WRITE_TOKEN;
    const raw = dataUrl("KEEP");
    await expect(persistableImageUrl(raw)).rejects.toThrow(/Refusing to store an inline image/);
    await expect(persistableImageUrl("/api/placeholder/1")).resolves.toBe("/api/placeholder/1");
    process.env.AWS_ACCESS_KEY_ID = "key";
    process.env.AWS_SECRET_ACCESS_KEY = "secret";
    process.env.AWS_ENDPOINT_URL_S3 = "https://storage.example";
    process.env.S3_BUCKET = "designs";
    await expect(
      persistableImageUrl(raw, {
        upload: async () => ({ url: "https://cdn.example/designs/new.png", key: "designs/new.png", backend: "s3" }),
      }),
    ).resolves.toBe("https://cdn.example/designs/new.png");
  });
});

describe("orders and analytics queries omit inline images", () => {
  it("selects a compact url and leaves the base64 payload in the database", async () => {
    const db = await memoryDb();
    const token = "ORDERSINLINEPAYLOAD";
    const raw = dataUrl(token);
    const embedded = `/api/preview?niche=gothic&src=${encodeURIComponent(raw)}`;
    const ordersSql = ordersListQuery(db).toSQL().sql;
    const analyticsSql = analyticsListingsQuery(db).toSQL().sql;
    expect(ordersSql).toContain("left(");
    expect(ordersSql).toContain("data:");
    expect(ordersSql.toLowerCase()).not.toMatch(/select\s+"listings"\."image_url"/);
    expect(analyticsSql).not.toContain("delivery_url");
    expect(analyticsSql).toContain("octet_length");

    const [plain] = await db
      .insert(listings)
      .values({
        niche: "alpine",
        productType: "pod",
        title: "Plain mug",
        tags: ["mug"],
        description: "short",
        imageUrl: "/api/mockup/mug?niche=alpine",
        priceChf: 19,
        netChf: 6,
        marginPct: 30,
        isDemo: false,
      })
      .returning();
    const [inline] = await db
      .insert(listings)
      .values({
        niche: "christmas",
        productType: "digital",
        title: "Inline download",
        tags: ["print"],
        description: "short",
        imageUrl: raw,
        deliveryUrl: raw,
        priceChf: 8,
        netChf: 5,
        marginPct: 70,
        isDemo: false,
      })
      .returning();
    const [preview] = await db
      .insert(listings)
      .values({
        niche: "gothic",
        productType: "digital",
        title: "Embedded preview",
        tags: ["print"],
        description: "short",
        imageUrl: embedded,
        deliveryUrl: raw,
        priceChf: 8,
        netChf: 5,
        marginPct: 70,
        isDemo: false,
      })
      .returning();
    const srcFirst = `/api/preview?src=${encodeURIComponent(raw)}&niche=birthday`;
    const [srcFirstListing] = await db
      .insert(listings)
      .values({
        niche: "birthday",
        productType: "digital",
        title: "Src first preview",
        tags: ["print"],
        description: "short",
        imageUrl: srcFirst,
        priceChf: 8,
        netChf: 5,
        marginPct: 70,
        isDemo: false,
      })
      .returning();
    await db.insert(orders).values([
      {
        etsyReceiptId: "inline-size-plain",
        listingId: plain.id,
        buyerCountry: "CH",
        totalChf: 19,
        feesChf: 2,
        profitChf: 6,
        fulfillmentStatus: "pending",
        isDemo: false,
      },
      {
        etsyReceiptId: "inline-size-data",
        listingId: inline.id,
        buyerCountry: "DE",
        totalChf: 8,
        feesChf: 1,
        profitChf: 5,
        fulfillmentStatus: "delivered_digital",
        isDemo: false,
      },
      {
        etsyReceiptId: "inline-size-embed",
        listingId: preview.id,
        buyerCountry: "FR",
        totalChf: 8,
        feesChf: 1,
        profitChf: 5,
        fulfillmentStatus: "delivered_digital",
        isDemo: false,
      },
    ]);

    const rows = await ordersListQuery(db);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(token);
    expect(serialized.length).toBeLessThan(20_000);
    const byReceipt = new Map(rows.map((row) => [row.order.etsyReceiptId, row.imageUrl]));
    expect(byReceipt.get("inline-size-plain")).toBe("/api/mockup/mug?niche=alpine");
    expect(byReceipt.get("inline-size-data")).toBe("/api/preview?niche=christmas");
    expect(byReceipt.get("inline-size-embed")).toBe("/api/preview?niche=gothic");

    const listed = await analyticsListingsQuery(db);
    expect(JSON.stringify(listed)).not.toContain(token);
    expect(listed.find((row) => row.id === preview.id)?.imageUrl).toBe("/api/preview?niche=gothic");
    expect(listed.find((row) => row.id === inline.id)?.imageUrl).toBe("/api/preview?niche=christmas");
    expect(listed.find((row) => row.id === srcFirstListing.id)?.imageUrl).toBe("/api/preview?niche=birthday");

    const displayed = await db
      .select({
        ...getTableColumns(listings),
        imageUrl: sql<string>`coalesce(${displayImageUrlSql(listings.imageUrl, listings.niche)}, '')`,
        deliveryUrl: compactImageUrlSql(listings.deliveryUrl),
      })
      .from(listings);
    const displayedJson = JSON.stringify(displayed);
    expect(displayedJson).not.toContain(token);
    expect(displayed.find((row) => row.id === plain.id)?.imageUrl).toBe("/api/mockup/mug?niche=alpine");
    expect(displayed.find((row) => row.id === inline.id)?.deliveryUrl).toBeNull();
    expect(displayed.find((row) => row.id === inline.id)?.imageUrl).toBe("/api/preview?niche=christmas");

    const [still] = await db.select({ imageUrl: listings.imageUrl }).from(listings).where(eq(listings.id, inline.id));
    expect(still.imageUrl).toContain(token);
  });
});

describe("image backfill", () => {
  it("reads a large value in chunks, uploads it once, and rewrites both tables", async () => {
    const db = await memoryDb();
    const token = "BACKFILLPAYLOAD";
    const raw = dataUrl(token);
    const [design] = await db
      .insert(designs)
      .values({ niche: "alpine", prompt: "p", provider: "openai", imageUrl: raw, isDemo: false })
      .returning();
    const [listing] = await db
      .insert(listings)
      .values({
        designId: design.id,
        niche: "alpine",
        productType: "digital",
        title: "Backfill me",
        tags: ["print"],
        description: "short",
        imageUrl: raw,
        deliveryUrl: raw,
        priceChf: 8,
        netChf: 5,
        marginPct: 70,
        isDemo: false,
      })
      .returning();
    const [embedded] = await db
      .insert(listings)
      .values({
        niche: "gothic",
        productType: "digital",
        title: "Embedded backfill",
        tags: ["print"],
        description: "short",
        imageUrl: `/api/preview?src=${encodeURIComponent(raw)}&niche=gothic`,
        priceChf: 8,
        netChf: 5,
        marginPct: 70,
        isDemo: false,
      })
      .returning();

    const read = await readTextColumn(db, listings, listings.imageUrl, listing.id, 1000);
    expect(read).toBe(raw);

    const dry = await backfillInlineImages(db, async () => {
      throw new Error("dry-run must not upload");
    }, { dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.listingCandidates).toBe(2);
    expect(dry.designCandidates).toBe(1);
    expect(dry.uploaded).toBe(0);
    expect(dry.listingBytes).toBeGreaterThan(raw.length);

    const uploads: string[] = [];
    const report = await backfillInlineImages(db, async (url) => {
      uploads.push(url);
      return "https://cdn.example/designs/stored.png";
    });
    expect(report.failed).toBe(0);
    expect(report.errors).toEqual([]);
    expect(uploads).toEqual([raw]);
    expect(report.uploaded).toBe(1);
    expect(report.updatedListings).toBe(2);
    expect(report.updatedDesigns).toBe(1);

    const [afterListing] = await db.select().from(listings).where(eq(listings.id, listing.id));
    const [afterEmbedded] = await db.select().from(listings).where(eq(listings.id, embedded.id));
    const [afterDesign] = await db.select().from(designs).where(eq(designs.id, design.id));
    expect(afterDesign.imageUrl).toBe("https://cdn.example/designs/stored.png");
    expect(afterListing.deliveryUrl).toBe("https://cdn.example/designs/stored.png");
    expect(afterListing.imageUrl).toContain("/api/preview?");
    expect(afterListing.imageUrl).toContain(encodeURIComponent("https://cdn.example/designs/stored.png"));
    expect(afterListing.imageUrl).not.toBe(afterListing.deliveryUrl);
    expect(afterEmbedded.imageUrl).toBe("/api/preview?niche=gothic&src=https%3A%2F%2Fcdn.example%2Fdesigns%2Fstored.png");
    expect(JSON.stringify([afterListing, afterEmbedded, afterDesign])).not.toContain(token);

    const again = await backfillInlineImages(db, async () => {
      throw new Error("second run must not upload");
    });
    expect(again.listingCandidates).toBe(0);
    expect(again.designCandidates).toBe(0);
    expect(again.updatedListings).toBe(0);
  });
});
