import { eq, inArray } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, type DB } from "@/db";
import { PrintifyDryRunAdapter } from "@/adapters/printify/dryrun";
import type { PrintifyAdapter } from "@/adapters/printify";
import { listings, type Listing } from "@/db/schema";
import { evaluateQualityGate, supplierMockupCount, WAITING_FOR_PRINTIFY_MOCKUPS } from "@/lib/quality-gate";
import { prepareSupplierPreview } from "@/pipeline/supplier-preview";
import { runPublish } from "@/pipeline/publish";
import { bulkSetListingStatus, setListingStatus, updateListing } from "@/app/actions";

const mocks = vi.hoisted(() => ({
  mode: "live" as "live" | "dry-run",
  createAndPublish: vi.fn(),
  getProductImages: vi.fn(),
  getProviderDetails: vi.fn(),
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
  mocks.getProviderDetails.mockResolvedValue({ processingMin: 2, processingMax: 4, shippingMin: 3, shippingMax: 7 });
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
    expect(mocks.createAndPublish).toHaveBeenCalledWith(expect.objectContaining({
      description: expect.stringContaining("Processing: 2–4 business days.\nShipping: 3–7 business days."),
    }));
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

  it("never approves a non-demo listing using synthetic previews when global writes are disabled", async () => {
    mocks.mode = "dry-run";
    mocks.getProductImages.mockResolvedValue([1, 2, 3].map((n) => ({ src: `/api/mockup/posterA3?synthetic=printify&view=${n}` })));
    const row = await draft({ isDemo: false });
    expect(await setListingStatus(row.id, "approved")).toMatchObject({ ok: false, error: expect.stringContaining("Verified production-provider") });
    const saved = await reload(row.id);
    expect(saved.status).toBe("pending_approval");
    expect(saved.printifyProductId).toBeNull();
    expect(supplierMockupCount(saved)).toBe(0);
  });

  it("surfaces a safe missing preset reason instead of pretending mockups are rendering", async () => {
    mocks.getProviderDetails.mockRejectedValue(new Error("No Printify blank pinned for Mug. Configure token secret-value."));
    const row = await draft({ podProvider: "printify:mug" });
    expect(await setListingStatus(row.id, "approved")).toEqual({ ok: false, error: "No Printify blank pinned for Mug" });
    expect((await reload(row.id)).validation).toContainEqual(expect.objectContaining({
      code: "supplier_preview_error", message: "No Printify blank pinned for Mug",
    }));
    expect(mocks.createAndPublish).not.toHaveBeenCalled();
  });

  it("keeps an undersized-art error actionable and clears it after a corrected retry", async () => {
    const row = await draft();
    const message = "Printify mug artwork is 600×800; minimum 2700×1125 native pixels required (no upscaling)";
    mocks.createAndPublish.mockRejectedValueOnce(new Error(message));
    expect(await setListingStatus(row.id, "approved")).toEqual({ ok: false, error: message });
    expect((await reload(row.id)).validation).toContainEqual(expect.objectContaining({ code: "supplier_preview_error", message }));
    expect(await setListingStatus(row.id, "approved")).toEqual({ ok: true });
    expect((await reload(row.id)).validation.some((issue) => issue.code === "supplier_preview_error")).toBe(false);
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

  it("refreshes missing or stale timing copy from the provider before validation", async () => {
    const row = await draft({ description: `${template.description}\n\nProcessing: 99–100 business days.\nShipping: 100–200 business days.` });
    expect(await setListingStatus(row.id, "approved")).toEqual({ ok: true });
    const saved = await reload(row.id);
    expect(saved.description).toContain("Processing: 2–4 business days.\nShipping: 3–7 business days.");
    expect(saved.description).not.toContain("99–100");
    expect(saved.copyProvenance).toMatchObject({ providerDetails: { processingMin: 2, processingMax: 4, shippingMin: 3, shippingMax: 7 } });
  });

  it("does not reuse cached timing proof when the provider refresh fails", async () => {
    const row = await draft();
    expect(await setListingStatus(row.id, "approved")).toEqual({ ok: true });
    await setListingStatus(row.id, "pending_approval");
    mocks.getProviderDetails.mockRejectedValue(new Error("provider unavailable"));
    mocks.createAndPublish.mockClear();
    expect(await setListingStatus(row.id, "approved")).toMatchObject({ ok: false, error: expect.stringContaining("Verified production-provider") });
    expect(mocks.createAndPublish).not.toHaveBeenCalled();
    expect((await reload(row.id)).status).toBe("pending_approval");
  });

  it("retries fresh missing timings and hydrates them before creation when the provider recovers", async () => {
    const row = await draft();
    mocks.getProviderDetails.mockRejectedValueOnce(new Error("provider facts pending"));
    expect(await setListingStatus(row.id, "approved")).toMatchObject({ ok: false });
    expect(mocks.createAndPublish).not.toHaveBeenCalled();
    expect(await setListingStatus(row.id, "approved")).toEqual({ ok: true });
    const saved = await reload(row.id);
    expect(saved.status).toBe("approved");
    expect(saved.validation.some((issue) => issue.code === "missing_provider_timings")).toBe(false);
    expect(mocks.getProviderDetails.mock.invocationCallOrder[1]).toBeLessThan(mocks.createAndPublish.mock.invocationCallOrder[0]);
  });

  it("reuses the supplier product while sending edited copy through create-only synchronization", async () => {
    const row = await draft();
    expect(await setListingStatus(row.id, "approved")).toEqual({ ok: true });
    await setListingStatus(row.id, "pending_approval");
    const saved = await reload(row.id);
    const title = "Alpine Mountain Poster";
    const description = `${saved.description}\n\nA revised alpine composition.`;
    expect(await updateListing(row.id, { title, description, tags: saved.tags, priceChf: saved.priceChf }, true)).toMatchObject({ ok: true });
    expect(mocks.createAndPublish).toHaveBeenLastCalledWith(expect.objectContaining({
      existingProductId: "supplier-product", title,
      description: expect.stringContaining("A revised alpine composition."), publishToEtsy: false,
    }));
    expect((await reload(row.id)).printifyProductId).toBe("supplier-product");
  });

  it("blocks the automatic quality path without three actual supplier views", async () => {
    const row = await draft();
    const input = { ...row, title: "Alpine Poster", podProvider: "printify:posterA3", priceChf: 24.9 };
    expect(evaluateQualityGate(input).reasons).toContainEqual(expect.objectContaining({ code: "supplier_mockups_pending", message: WAITING_FOR_PRINTIFY_MOCKUPS }));
    expect(supplierMockupCount({ gallery: row.gallery })).toBe(0);
  });

  it.each(["rejected", "publishing"] as const)("preserves a concurrent %s transition during provider timing lookup", async (status) => {
    await db.update(listings).set({ status: "rejected" }).where(inArray(listings.status, ["approved", "failed"]));
    const row = await draft({ status: "approved" });
    mocks.getProviderDetails.mockImplementationOnce(async () => {
      await db.update(listings).set({
        status, updatedAt: new Date(),
        ...(status === "publishing" ? { publishAttemptCount: 1, publishAttemptedAt: new Date() } : {}),
      }).where(eq(listings.id, row.id));
      return { processingMin: 2, processingMax: 4, shippingMin: 3, shippingMax: 7 };
    });
    await runPublish({ db, shopId: row.shopId, now: new Date(), demo: true, trigger: "manual", random: () => 0.5, log: vi.fn() });
    const saved = await reload(row.id);
    expect(saved.status).toBe(status);
    expect(saved.publishAttemptCount).toBe(status === "publishing" ? 1 : 0);
    expect(mocks.createAndPublish).not.toHaveBeenCalled();
  });

  it("does not resurrect a rejected listing during supplier image polling", async () => {
    const row = await draft();
    mocks.getProductImages.mockImplementationOnce(async () => {
      await db.update(listings).set({ status: "rejected", updatedAt: new Date() }).where(eq(listings.id, row.id));
      return images(3);
    });
    const result = await prepareSupplierPreview(db, row);
    expect(result.ready).toBe(false);
    const saved = await reload(row.id);
    expect(saved.status).toBe("rejected");
    expect(saved.printifyProductId).toBe("supplier-product");
  });
});
