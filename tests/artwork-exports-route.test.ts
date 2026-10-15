import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { designs, listings, shops } from "@/db/schema";
import { inspectArtworkFile } from "@/lib/file-manifest";
import { rgbPng } from "@/lib/png";
import { deliveryPackIsComplete, verifyListingDeliveryPack } from "@/lib/artwork-pack";
import { digitalActivationRefusal, digitalDraftRefusal } from "@/lib/publish-gates";
import { createListingExports, parseArtworkExportSpecs } from "@/pipeline/artwork-exports";
import { activateDigitalListing, markDeliveryVerified, recordDeliveryManifest } from "@/pipeline/human-publish";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(), getDb: vi.fn(), resolveRequestShop: vi.fn(),
  read: vi.fn(), upload: vi.fn(), activate: vi.fn(), getEtsy: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/lib/shops", () => ({ resolveRequestShop: mocks.resolveRequestShop }));
vi.mock("@/lib/artwork-source", async (original) => ({
  ...await original<typeof import("@/lib/artwork-source")>(), loadArtworkBytes: mocks.read,
}));
vi.mock("@/lib/object-storage", async (original) => ({
  ...await original<typeof import("@/lib/object-storage")>(), uploadImageBytes: mocks.upload,
}));
vi.mock("@/adapters/etsy", () => ({ getEtsyAdapter: mocks.getEtsy }));
import { POST } from "@/app/api/listings/[id]/exports/route";

const source = rgbPng(40, 60, [40, 80, 120]);
const originalUrl = "https://storage.example/original.png";
const plan = { exports: [{ filename: "small.png", width: 20, height: 30, format: "png" }] };
const objects = new Map<string, Buffer>();
let db: DB;
let client: PGlite;
let shopId: string;
let designId: number;
let uploadIndex = 0;

beforeAll(async () => {
  client = new PGlite("memory://");
  db = drizzle(client, { schema }) as unknown as DB;
  await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  [shopId] = (await db.select().from(shops)).map((shop) => shop.id);
  const [design] = await db.insert(designs).values({ shopId, niche: "alpine", prompt: "poster", provider: "runpod", imageUrl: originalUrl }).returning();
  designId = design.id;
});
afterAll(async () => { await client.close(); });
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("IMAGE_PROVIDER", "runpod");
  objects.clear();
  objects.set(originalUrl, source);
  mocks.requireAuth.mockResolvedValue(undefined);
  mocks.getDb.mockResolvedValue(db);
  mocks.resolveRequestShop.mockResolvedValue({ id: shopId });
  mocks.getEtsy.mockResolvedValue({ mode: "live", activateListing: mocks.activate });
  mocks.read.mockImplementation(async (url: string) => objects.get(url) ?? null);
  mocks.upload.mockImplementation(async (bytes: Buffer) => {
    const url = `https://storage.example/export-${++uploadIndex}.png`;
    objects.set(url, Buffer.from(bytes));
    return { url, backend: "s3", key: `export-${uploadIndex}.png` };
  });
});
afterEach(() => { vi.unstubAllEnvs(); });

async function fixture(overrides: Partial<typeof listings.$inferInsert> = {}) {
  const delivery = (await inspectArtworkFile(source, "original.png"))!;
  const [listing] = await db.insert(listings).values({
    shopId, designId, niche: "alpine", productType: "digital", title: "Alpine artwork",
    tags: ["alpine"], description: "One original digital artwork.", imageUrl: "/api/preview?niche=alpine",
    deliveryUrl: originalUrl, fileManifest: { delivery }, priceChf: 5.9, netChf: 4, marginPct: 60,
    status: "approved", approvedAt: new Date(), fileVerifiedAt: new Date(), fileVerifiedBy: "operator",
    ...overrides,
  }).returning();
  return listing;
}

function request(body: unknown = plan) {
  return new Request("https://app.example/api/listings/1/exports", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}
function context(id: number | string) { return { params: Promise.resolve({ id: String(id) }) }; }
async function row(id: number) { return (await db.select().from(listings).where(eq(listings.id, id)))[0]; }

describe("authenticated operator export route", () => {
  it("authenticates before touching request data, params, storage or database", async () => {
    mocks.requireAuth.mockRejectedValueOnce(new Error("Unauthorized"));
    const read = vi.fn(() => { throw new Error("read before auth"); });
    const req = { get headers() { return read(); }, get body() { return read(); } } as unknown as Request;
    expect((await POST(req, { get params() { return read(); } })).status).toBe(401);
    expect(read).not.toHaveBeenCalled();
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("rejects another shop's listing and never trusts a supplied shop/source", async () => {
    const listing = await fixture();
    mocks.resolveRequestShop.mockResolvedValueOnce({ id: crypto.randomUUID() });
    expect((await POST(request(), context(listing.id))).status).toBe(404);
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect((await POST(request({ ...plan, shopId, source: "https://private.example/x" }), context(listing.id))).status).toBe(400);
  });

  it("stores verified files only, keeps the original primary, and clears approval/human verification", async () => {
    const listing = await fixture();
    const response = await POST(request(), context(listing.id));
    expect(response.status).toBe(200);
    const updated = await row(listing.id);
    expect(updated.deliveryUrl).toBe(originalUrl);
    expect(updated.fileManifest).toEqual(listing.fileManifest);
    expect(updated.deliveryPack?.files).toHaveLength(1);
    expect(updated).toMatchObject({ status: "pending_approval", approvedAt: null, fileVerifiedAt: null, fileVerifiedBy: null, etsyListingId: null });
    expect(updated.description).toContain("awaiting human verification");
    expect(updated.description).toContain("small.png: 20 × 30 pixels");
    expect(updated.description).not.toContain("Included digital files");
    expect(mocks.getEtsy).not.toHaveBeenCalled();
    expect(mocks.upload).toHaveBeenCalledWith(expect.any(Buffer), "image/png", true);
    expect(await verifyListingDeliveryPack(updated)).toBe(true);
  });

  it("accepts only unsent digital drafts and blocks immutable Etsy/published/rejected/POD rows", async () => {
    for (const overrides of [
      { etsyListingId: "123" }, { status: "published" as const }, { status: "rejected" as const },
      { status: "publishing" as const }, { productType: "pod" as const },
    ]) {
      const listing = await fixture(overrides);
      expect((await POST(request(), context(listing.id))).status).toBe(409);
    }
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("rejects malformed, oversized and invalid explicit plans without attaching files", async () => {
    const listing = await fixture();
    for (const exports of [
      [], Array.from({ length: 5 }, (_, i) => ({ ...plan.exports[0], filename: `file-${i}.png` })),
      [{ ...plan.exports[0], filename: "../small.png" }], [plan.exports[0], plan.exports[0]],
      [{ ...plan.exports[0], format: "gif" }], [null],
    ]) expect((await POST(request({ exports }), context(listing.id))).status).toBe(400);
    for (const exports of [
      [{ ...plan.exports[0], width: 80, height: 120 }], [{ ...plan.exports[0], width: 20, height: 20 }],
    ]) expect((await POST(request({ exports }), context(listing.id))).status).toBe(422);
    const malformed = new Request("https://app.example", { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    expect((await POST(malformed, context(listing.id))).status).toBe(400);
    const oversized = new Request("https://app.example", { method: "POST", headers: { "content-type": "application/json" }, body: " ".repeat(8193) });
    expect((await POST(oversized, context(listing.id))).status).toBe(413);
    expect((await row(listing.id)).deliveryPack).toBeNull();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("enforces the five-file total and refuses an original above 20MB", async () => {
    const listing = await fixture();
    const exports = [
      { filename: "small.png", width: 20, height: 30, format: "png" },
      { filename: "small.jpg", width: 20, height: 30, format: "jpeg" },
      { filename: "small.webp", width: 20, height: 30, format: "webp" },
      { filename: "tiny.png", width: 10, height: 15, format: "png" },
    ];
    expect((await POST(request({ exports }), context(listing.id))).status).toBe(200);
    expect((await row(listing.id)).deliveryPack?.files).toHaveLength(4);
    objects.set(originalUrl, Buffer.alloc(20 * 1024 * 1024 + 1));
    expect((await POST(request(), context(listing.id))).status).toBe(400);
  });

  it("rejects invalid ids/media types before database access", async () => {
    expect((await POST(request(), context("1e3"))).status).toBe(400);
    const req = new Request("https://app.example", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    expect((await POST(req, context(1))).status).toBe(415);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("does not attach a pack when upload/read-back fails or the draft changes during generation", async () => {
    const listing = await fixture();
    mocks.upload.mockResolvedValueOnce(null);
    expect((await POST(request(), context(listing.id))).status).toBe(422);
    expect((await row(listing.id)).deliveryPack).toBeNull();
    mocks.upload.mockImplementationOnce(async (bytes: Buffer) => {
      const url = "https://storage.example/race.png";
      objects.set(url, bytes);
      await db.update(listings).set({ etsyListingId: "race-draft" }).where(eq(listings.id, listing.id));
      return { url };
    });
    expect((await POST(request(), context(listing.id))).status).toBe(409);
    expect((await row(listing.id)).deliveryPack).toBeNull();
  });
});

describe("complete-pack human verification and publication gates", () => {
  it("requires all files to remain readable/hash-matched and records truthful included files only after human review", async () => {
    const listing = await fixture();
    await createListingExports(db, shopId, listing.id, plan);
    expect(await markDeliveryVerified(db, listing.id, "human")).toEqual({ ok: true });
    const verified = await row(listing.id);
    expect(verified.description).toContain("Included digital files (2)");
    expect(verified.fileVerifiedBy).toBe("human");
    const input = {
      imageProvider: "runpod", designProvider: "runpod", imageUrl: verified.imageUrl, deliveryUrl: verified.deliveryUrl,
      manifest: verified.fileManifest, fileVerifiedAt: verified.fileVerifiedAt, deliveryPack: verified.deliveryPack, etsyListingId: "draft",
    };
    expect(digitalDraftRefusal({ ...input, etsyMode: "live", deliveryPackVerified: true })).toBeNull();
    expect(digitalDraftRefusal({ ...input, etsyMode: "live" })).toMatch(/hash-checked/);
    expect(digitalActivationRefusal({ ...input, deliveryPackVerified: true })).toBeNull();
    expect(digitalActivationRefusal({ ...input, deliveryPackVerified: false })).toMatch(/changed/);
    objects.set(verified.deliveryPack!.files[0].url, rgbPng(20, 30, [255, 0, 0]));
    expect(await verifyListingDeliveryPack(verified)).toBe(false);
    expect((await markDeliveryVerified(db, listing.id, "human")).ok).toBe(false);
    expect((await row(listing.id)).fileVerifiedAt).toBeNull();
    expect((await row(listing.id)).description).toContain("awaiting human verification");
    await db.update(listings).set({ fileVerifiedAt: new Date(), etsyListingId: "draft" }).where(eq(listings.id, listing.id));
    expect((await activateDigitalListing(db, listing.id)).ok).toBe(false);
    expect(mocks.activate).not.toHaveBeenCalled();
    expect((await row(listing.id)).fileVerifiedAt).toBeNull();
  });

  it("rejects changed originals, extra files, oversized entries and missing stored exports", async () => {
    const listing = await fixture();
    await createListingExports(db, shopId, listing.id, plan);
    const attached = await row(listing.id);
    const pack = attached.deliveryPack!;
    expect(deliveryPackIsComplete({ ...pack, files: Array(5).fill(pack.files[0]) }, attached.fileManifest!.delivery)).toBe(false);
    expect(deliveryPackIsComplete({ ...pack, source: { ...pack.source, bytes: 20 * 1024 * 1024 + 1 } })).toBe(false);
    objects.delete(pack.files[0].url);
    expect(await verifyListingDeliveryPack(attached)).toBe(false);
    objects.set(pack.files[0].url, source);
    objects.set(originalUrl, rgbPng(40, 60, [1, 2, 3]));
    expect(await verifyListingDeliveryPack(attached)).toBe(false);
    expect((await POST(request(), context(listing.id))).status).toBe(409);
  });

  it("re-recording the primary clears verification; no-pack listings retain their existing human workflow", async () => {
    const url = `data:image/png;base64,${source.toString("base64")}`;
    const listing = await fixture({ deliveryUrl: url });
    objects.set(url, source);
    expect((await recordDeliveryManifest(db, listing.id)).ok).toBe(true);
    expect((await row(listing.id)).fileVerifiedAt).toBeNull();
    expect(await markDeliveryVerified(db, listing.id, "human")).toEqual({ ok: true });
    await db.update(listings).set({ etsyListingId: "single-draft" }).where(eq(listings.id, listing.id));
    expect((await activateDigitalListing(db, listing.id)).ok).toBe(true);
    expect(mocks.getEtsy).toHaveBeenCalledWith(db, undefined, "write", shopId);
    expect(mocks.activate).toHaveBeenCalledWith("single-draft");
  });

  it("re-recording also checks attached objects and requires fresh review for stale exports", async () => {
    const url = `data:image/png;base64,${source.toString("base64")}`;
    const listing = await fixture({ deliveryUrl: url });
    objects.set(url, source);
    await createListingExports(db, shopId, listing.id, plan);
    expect((await markDeliveryVerified(db, listing.id, "human")).ok).toBe(true);
    const attached = await row(listing.id);
    objects.delete(attached.deliveryPack!.files[0].url);
    expect((await recordDeliveryManifest(db, listing.id)).ok).toBe(false);
    expect((await row(listing.id)).fileVerifiedAt).toBeNull();
    expect((await row(listing.id)).description).toContain("awaiting human verification");
  });

  it("never marks a real Etsy draft activated through a dry-run fallback", async () => {
    const listing = await fixture({ etsyListingId: "12345678" });
    mocks.getEtsy.mockResolvedValueOnce({ mode: "dry-run", activateListing: mocks.activate });
    const result = await activateDigitalListing(db, listing.id);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: expect.stringContaining("live writes are disabled") });
    expect(mocks.activate).not.toHaveBeenCalled();
    expect((await row(listing.id)).activatedAt).toBeNull();
    expect(mocks.getEtsy).toHaveBeenCalledWith(db, undefined, "write", shopId);
  });

  it("validates unknown input safely", () => {
    for (const input of [null, [], {}, { exports: [null] }, { exports: [{ ...plan.exports[0], width: 1.5 }] }]) {
      expect(() => parseArtworkExportSpecs(input)).toThrow();
    }
  });
});
