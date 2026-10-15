import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { EtsyAmbiguousWriteError } from "@/adapters/etsy/transport";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { listings, shops } from "@/db/schema";
import { withDisclosures } from "@/lib/disclosures";
import { etsyDeliveryFingerprint } from "@/lib/etsy-delivery";
import { runPublish, PUBLISH_RETRY_MS } from "@/pipeline/publish";
import type { StageContext } from "@/pipeline/types";

const adapters = vi.hoisted(() => ({ etsy: vi.fn(), printify: vi.fn() }));
vi.mock("@/adapters/etsy", () => ({ getEtsyAdapter: adapters.etsy }));
vi.mock("@/adapters/printify", () => ({ getPrintifyAdapter: adapters.printify }));
vi.mock("@/lib/artwork-pack", async (original) => ({
  ...await original<typeof import("@/lib/artwork-pack")>(),
  verifyListingDeliveryPack: vi.fn(async () => true),
}));

let client: PGlite;
let db: DB;
let shopId: string;
const now = new Date("2026-10-15T12:00:00Z");
const tags = ["swiss alps art", "mountain wall art", "alpine decor", "minimalist poster", "nature print",
  "scandi wall art", "switzerland gift", "hiking gift", "cabin decor", "matterhorn",
  "travel poster", "gallery wall", "neutral wall art"];
const file = (name: string, size: number) => ({
  filename: name, width: size, height: size, bytes: 100, sha256: "a".repeat(64), format: "png" as const,
  colourSpace: name === "artwork.png" ? "source" as const : "srgb" as const,
});
const ctx = (at = now): StageContext => ({ db, shopId, now: at, demo: true, trigger: "manual", random: () => 0, log: () => {} });

beforeAll(async () => {
  client = new PGlite("memory://");
  db = drizzle(client, { schema }) as unknown as DB;
  await migrate(db as unknown as ReturnType<typeof drizzle>, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  [shopId] = (await db.select({ id: shops.id }).from(shops)).map((shop) => shop.id);
});
afterEach(async () => {
  await db.execute(sql`delete from listings`);
  vi.clearAllMocks();
});
afterAll(async () => { await client.close(); });

async function draft(pack = false) {
  const source = file("artwork.png", 1024);
  const [row] = await db.insert(listings).values({
    shopId, niche: "alpine", productType: "digital", status: "approved", isDemo: true,
    title: "Swiss Alps Wall Art Printable, Minimalist Mountain Poster, Alpine Decor",
    description: withDisclosures("Swiss alpine artwork. One original PNG for personal use.", "digital"),
    tags, imageUrl: "/api/preview/1?src=https%3A%2F%2Fassets.example%2Fartwork.png",
    deliveryUrl: "https://assets.example/artwork.png", priceChf: 8, podCostChf: 0, netChf: 6, marginPct: 75,
    fileManifest: { delivery: source }, fileVerifiedAt: pack ? now : null,
    ...(pack ? { deliveryPack: { version: 1 as const, source, files: [{ ...file("small.png", 512), url: "https://assets.example/small.png" }] } } : {}),
  }).returning();
  return row;
}

it("holds an ambiguous create forever instead of creating another listing on the next day", async () => {
  const row = await draft();
  const createDraftListing = vi.fn().mockRejectedValue(new EtsyAmbiguousWriteError());
  adapters.etsy.mockResolvedValue({ mode: "dry-run", createDraftListing });
  adapters.printify.mockResolvedValue({ mode: "dry-run" });
  await expect(runPublish(ctx())).rejects.toThrow("failed 1");
  const [failed] = await db.select().from(listings).where(eq(listings.id, row.id));
  expect(failed.publishError).toMatch(/^Publish attempt ended without a recorded provider result/);
  await runPublish(ctx(new Date(now.getTime() + 2 * PUBLISH_RETRY_MS)));
  expect(createDraftListing).toHaveBeenCalledTimes(1);
  expect(adapters.etsy).toHaveBeenCalledWith(db, expect.any(Function), "write", shopId);
});

it("retains the created draft and holds a subsequent upload failure for reconciliation", async () => {
  const row = await draft();
  const createDraftListing = vi.fn().mockResolvedValue({ listingId: "dry-existing" });
  adapters.etsy.mockResolvedValue({ mode: "dry-run", createDraftListing,
    uploadListingImage: vi.fn().mockRejectedValue(new Error("Upload interrupted")) });
  adapters.printify.mockResolvedValue({ mode: "dry-run" });
  await expect(runPublish(ctx())).rejects.toThrow("failed 1");
  const [failed] = await db.select().from(listings).where(eq(listings.id, row.id));
  expect(failed.etsyListingId).toBe("dry-existing");
  expect(failed.etsyDeliveryFingerprint).toBeNull();
  expect(failed.publishError).toMatch(/^Publish attempt ended without a recorded provider result/);
  await runPublish(ctx(new Date(now.getTime() + 2 * PUBLISH_RETRY_MS)));
  expect(createDraftListing).toHaveBeenCalledTimes(1);
});

it("uploads every verified pack file without activating the listing", async () => {
  await draft(true);
  const uploadListingFile = vi.fn();
  const activateListing = vi.fn();
  adapters.etsy.mockResolvedValue({ mode: "dry-run", createDraftListing: vi.fn().mockResolvedValue({ listingId: "dry-pack" }),
    uploadListingImage: vi.fn(), uploadListingFile, activateListing });
  adapters.printify.mockResolvedValue({ mode: "dry-run" });
  await expect(runPublish(ctx())).resolves.toMatch(/Published 1/);
  expect(uploadListingFile.mock.calls).toEqual([
    ["dry-pack", { name: "artwork.png", url: "https://assets.example/artwork.png" }],
    ["dry-pack", { name: "small.png", url: "https://assets.example/small.png" }],
  ]);
  expect(activateListing).not.toHaveBeenCalled();
  const [published] = await db.select().from(listings);
  expect(published.etsyDeliveryFingerprint).toBe(etsyDeliveryFingerprint(published));
  expect(published.etsyDeliveryFingerprint).not.toBe(etsyDeliveryFingerprint({ ...published,
    deliveryPack: { ...published.deliveryPack!, files: published.deliveryPack!.files.map((entry) => ({ ...entry, filename: "changed.png" })) } }));
});
