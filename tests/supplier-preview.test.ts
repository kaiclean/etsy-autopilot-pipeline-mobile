import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, type DB } from "@/db";
import { PrintifyDryRunAdapter } from "@/adapters/printify/dryrun";
import type { PrintifyAdapter } from "@/adapters/printify";
import { listings, type Listing } from "@/db/schema";
import { evaluateQualityGate, supplierMockupCount, WAITING_FOR_PRINTIFY_MOCKUPS } from "@/lib/quality-gate";
import { prepareSupplierPreview } from "@/pipeline/supplier-preview";
import { bulkSetListingStatus, setListingStatus, updateListing } from "@/app/actions";

const mocks = vi.hoisted(() => ({
  mode: "live" as "live" | "dry-run",
  createAndPublish: vi.fn(),
  getProductImages: vi.fn(),
  getPrintifyAdapter: vi.fn(),
}));
vi.mock("@/adapters/printify", () => ({ getPrintifyAdapter: mocks.getPrintifyAdapter }));
vi.mock("@/lib/session", () => ({ requireAuth: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), refresh: vi.fn() }));

let db: DB;
let template: Listing;
const images = (count: number) => Array.from({ length: count }, (_, n) => ({ src: `https://images.printify.example/product-${n}.jpg` }));

beforeAll(async () => {
  db = await getDb();
  const rows = await db.select().from(listings);
  const source = rows.find((row) => row.productType === "pod");
  if (!source) throw new Error("No POD seed");
  template = source;
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.mode = "live";
  mocks.getPrintifyAdapter.mockResolvedValue(mocks);
  mocks.createAndPublish.mockImplementation(async (input) => ({
    productId: input.existingProductId ?? (mocks.mode === "live" ? "supplier-product" : "dry-supplier-product"),
    blueprintId: 42, printProviderId: 7,
  }));
  mocks.getProductImages.mockResolvedValue(images(3));
});

async function draft(patch: Partial<typeof listings.$inferInsert> = {}) {
  const [row] = await db.insert(listings).values({
    niche: template.niche, productType: "pod", podProvider: "printify:posterA3", supplier: "printify",
    title: template.title, tags: template.tags, description: template.description,
    imageUrl: "/api/mockup/posterA3?niche=alpine",
    deliveryUrl: "https://art.example/print-master.png",
    priceChf: template.priceChf, podCostChf: template.podCostChf,
    netChf: template.netChf, marginPct: template.marginPct,
    status: "pending_approval", isDemo: false, validation: [],
    gallery: [{ url: "/api/preview?niche=alpine", role: "artwork-preview", source: "illustrative", label: "Composition only" }],
    ...patch,
  }).returning();
  return row;
}

async function reload(id: number) {
  const [row] = await db.select().from(listings).where(eq(listings.id, id));
  return row;
}

describe("supplier previews before approval", () => {
  it("provides explicitly synthetic demo fixture views, not live supplier proof", async () => {
    const adapter: PrintifyAdapter = new PrintifyDryRunAdapter(() => 0.5);
    const product = await adapter.createAndPublish({
      title: "Alpine Poster", description: template.description, tags: template.tags, priceChf: 24.9,
      imageUrl: "https://art.example/print-master.png", preset: "posterA3", publishToEtsy: false,
    });
    const previews = await adapter.getProductImages!(product.productId);
    expect(new Set(previews.map((image) => image.src)).size).toBeGreaterThanOrEqual(3);
    expect(previews.every((image) => /synthetic/.test(image.src))).toBe(true);
  });

  it.each([0, 1, 2])("holds %i supplier images pending without publishing", async (count) => {
    const row = await draft();
    mocks.getProductImages.mockResolvedValue(images(count));
    const result = await setListingStatus(row.id, "approved");
    expect(result).toEqual({ ok: false, error: WAITING_FOR_PRINTIFY_MOCKUPS });
    const saved = await reload(row.id);
    expect(saved).toMatchObject({ status: "pending_approval", printifyProductId: "supplier-product", approvedAt: null, etsyListingId: null, podPublishedAt: null });
    expect(saved.validation).toContainEqual(expect.objectContaining({ message: WAITING_FOR_PRINTIFY_MOCKUPS }));
    expect(mocks.createAndPublish).toHaveBeenCalledWith(expect.objectContaining({ publishToEtsy: false, imageUrl: "https://art.example/print-master.png" }));
    expect(mocks.getPrintifyAdapter).toHaveBeenCalledWith({ db, intent: "write" });
  });

  it("reuses the created product, refreshes delayed images, and preserves illustrative views", async () => {
    const row = await draft();
    mocks.getProductImages.mockResolvedValueOnce(images(2));
    await setListingStatus(row.id, "approved");
    expect(await setListingStatus(row.id, "approved")).toEqual({ ok: true });
    expect(mocks.createAndPublish.mock.calls[1][0]).toMatchObject({ existingProductId: "supplier-product", publishToEtsy: false });
    const saved = await reload(row.id);
    expect(saved.status).toBe("approved");
    expect(saved.gallery.filter((view) => view.source === "supplier")).toHaveLength(3);
    expect(saved.gallery).toContainEqual(expect.objectContaining({ source: "illustrative", role: "artwork-preview" }));
    expect(saved.etsyListingId).toBeNull();
  });

  it("deduplicates and caps actual supplier images at ten", async () => {
    const row = await draft();
    mocks.getProductImages.mockResolvedValue([...images(12), ...images(12)]);
    const result = await prepareSupplierPreview(db, row);
    expect(result.ready).toBe(true);
    expect(result.listing.gallery).toHaveLength(10);
    expect(supplierMockupCount(result.listing)).toBe(10);
  });

  it("does not count duplicates, illustrative previews, or synthetic live images", async () => {
    const row = await draft();
    mocks.getProductImages.mockResolvedValue([...images(1), ...images(1), ...images(1)]);
    expect((await prepareSupplierPreview(db, row)).ready).toBe(false);
    mocks.getProductImages.mockResolvedValue([1, 2, 3].map((n) => ({ src: `https://app.example/api/mockup/posterA3?synthetic=printify&view=${n}` })));
    expect((await prepareSupplierPreview(db, await reload(row.id))).ready).toBe(false);
  });

  it("labels demo images synthetic and never accepts those proofs in live quality checks", async () => {
    mocks.mode = "dry-run";
    mocks.getProductImages.mockResolvedValue([1, 2, 3].map((n) => ({ src: `/api/mockup/posterA3?synthetic=printify&view=${n}` })));
    const result = await prepareSupplierPreview(db, await draft({ isDemo: true }));
    expect(result.ready).toBe(true);
    expect(result.listing.gallery[0]).toMatchObject({ source: "synthetic", label: expect.stringContaining("not supplier proof") });
    expect(supplierMockupCount({ ...result.listing, publishMode: "live" })).toBe(0);
  });

  it("persists creation before an image read failure so retries reuse its id", async () => {
    const row = await draft();
    mocks.getProductImages.mockRejectedValueOnce(new Error("rendering pending"));
    expect((await prepareSupplierPreview(db, row)).ready).toBe(false);
    await prepareSupplierPreview(db, await reload(row.id));
    expect(mocks.createAndPublish.mock.calls[1][0].existingProductId).toBe("supplier-product");
  });

  it("does not fabricate proof when write gates return a dry-run adapter for a real id", async () => {
    mocks.mode = "dry-run";
    const row = await draft({ printifyProductId: "real-product" });
    expect((await prepareSupplierPreview(db, row)).ready).toBe(false);
    expect(mocks.createAndPublish).not.toHaveBeenCalled();
    expect(mocks.getProductImages).not.toHaveBeenCalled();
    expect(mocks.getPrintifyAdapter).toHaveBeenLastCalledWith({ db, intent: "read" });
  });

  it("never creates a live supplier product from a demo listing", async () => {
    expect((await prepareSupplierPreview(db, await draft({ isDemo: true }))).ready).toBe(false);
    expect(mocks.createAndPublish).not.toHaveBeenCalled();
  });

  it("applies the same hold to edit-and-approve and bulk approvals", async () => {
    const edited = await draft();
    const bulk = await draft();
    mocks.getProductImages.mockResolvedValue(images(2));
    expect(await updateListing(edited.id, {
      title: edited.title, tags: edited.tags, description: edited.description, priceChf: edited.priceChf,
    }, true)).toMatchObject({ ok: false, error: WAITING_FOR_PRINTIFY_MOCKUPS });
    const result = await bulkSetListingStatus([bulk.id], "approved");
    expect(result).toMatchObject({ changed: [], skipped: [{ id: bulk.id, error: WAITING_FOR_PRINTIFY_MOCKUPS }] });
    expect((await reload(edited.id)).status).toBe("pending_approval");
    expect((await reload(bulk.id)).status).toBe("pending_approval");
  });

  it("allows edit-and-approve and bulk approval only with three supplier images", async () => {
    const edited = await draft();
    const bulk = await draft();
    expect(await updateListing(edited.id, {
      title: edited.title, tags: edited.tags, priceChf: edited.priceChf,
    }, true)).toMatchObject({ ok: true });
    expect(await bulkSetListingStatus([bulk.id], "approved")).toMatchObject({ changed: [bulk.id], skipped: [] });
    expect((await reload(edited.id)).status).toBe("approved");
    expect((await reload(bulk.id)).status).toBe("approved");
  });

  it("blocks the automatic quality path without three actual supplier views", async () => {
    const row = await draft();
    const input = { ...row, title: "Alpine Poster", podProvider: "printify:posterA3", priceChf: 24.9 };
    expect(evaluateQualityGate(input).reasons).toContainEqual(expect.objectContaining({ code: "supplier_mockups_pending", message: WAITING_FOR_PRINTIFY_MOCKUPS }));
    expect(supplierMockupCount({ gallery: row.gallery })).toBe(0);
  });
});
