import { eq, inArray } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { getDb, type DB } from "@/db";
import { costs, listings } from "@/db/schema";
import { validateListing } from "@/lib/listing-validator";
import { publishPodListingToEtsy, recordPodSample } from "@/pipeline/human-publish";
import { runStage } from "@/pipeline/runner";

const adapters = vi.hoisted(() => ({
  getEtsyAdapter: vi.fn(),
  getPrintifyAdapter: vi.fn(),
}));

vi.mock("@/adapters/etsy", () => ({ getEtsyAdapter: adapters.getEtsyAdapter }));
vi.mock("@/adapters/printify", () => ({ getPrintifyAdapter: adapters.getPrintifyAdapter }));

adapters.getEtsyAdapter.mockResolvedValue({
  mode: "dry-run",
  createDraftListing: vi.fn(),
  uploadListingImage: vi.fn(),
  uploadListingFile: vi.fn(),
  activateListing: vi.fn(),
  getReceipts: vi.fn(async () => []),
  getListingStats: vi.fn(async () => ({})),
});

describe("publish stage POD status", () => {
  let db: DB;

  beforeAll(async () => {
    db = await getDb();
    await db.update(listings).set({ status: "rejected" }).where(inArray(listings.status, ["approved", "failed"]));
  });

  async function approvePod() {
    const seeded = await db.select().from(listings);
    const src = seeded.find((row) => row.productType === "pod" && validateListing(row).valid);
    if (!src) throw new Error("seed has no valid POD listing");
    const [row] = await db
      .insert(listings)
      .values({
        niche: src.niche,
        productType: "pod",
        podProvider: "printify:posterA3",
        title: src.title,
        tags: src.tags,
        description: src.description,
        imageUrl: src.imageUrl,
        priceChf: src.priceChf,
        podCostChf: src.podCostChf,
        netChf: src.netChf,
        marginPct: src.marginPct,
        validation: src.validation,
        status: "approved",
        etsyListingId: null,
        printifyProductId: null,
        isDemo: false,
      })
      .returning();
    return row;
  }

  async function createdPod(productId: string) {
    const seeded = await db.select().from(listings);
    const src = seeded.find((row) => row.productType === "pod" && validateListing(row).valid);
    if (!src) throw new Error("seed has no valid POD listing");
    const [row] = await db
      .insert(listings)
      .values({
        niche: src.niche,
        productType: "pod",
        podProvider: "printify:posterA3",
        title: src.title,
        tags: src.tags,
        description: src.description,
        imageUrl: src.imageUrl,
        priceChf: src.priceChf,
        podCostChf: src.podCostChf,
        netChf: src.netChf,
        marginPct: src.marginPct,
        validation: src.validation,
        status: "pod_created",
        etsyListingId: null,
        printifyProductId: productId,
        podBlueprintId: 42,
        podPrintProviderId: 7,
        isDemo: false,
      })
      .returning();
    await recordPodSample(db, { blueprintId: 42, providerId: 7, actor: "test", note: "sample" });
    return row;
  }

  it("cron create stays pod_created and does not publish to Etsy", async () => {
    const row = await approvePod();
    const createAndPublish = vi.fn(async () => ({ productId: "pfy-created-only", blueprintId: 42, printProviderId: 7 }));
    adapters.getPrintifyAdapter.mockResolvedValue({
      mode: "live",
      createAndPublish,
      getExternalEtsyIds: vi.fn(async () => ({})),
      getOrderStatuses: vi.fn(async () => ({})),
    });
    const run = await runStage("publish", "manual", { db, random: () => 0.5, now: new Date() });
    expect(run.status, run.summary ?? "").toBe("success");
    expect(run.summary).toMatch(/Published 1, failed 0/);
    expect(createAndPublish).toHaveBeenCalledWith(expect.objectContaining({ publishToEtsy: false }));
    const [after] = await db.select().from(listings).where(eq(listings.id, row.id));
    expect(after.status).toBe("pod_created");
    expect(after.etsyListingId).toBeNull();
    expect(after.publishedAt).toBeNull();
    expect(after.podPublishedAt).toBeNull();
    expect(after.printifyProductId).toBe("pfy-created-only");
  });

  it("human publish without an Etsy id enters publishing and does not charge another listing fee", async () => {
    const row = await createdPod("pfy-human-wait");
    const before = (await db.select().from(costs)).length;
    const now = new Date("2026-10-05T12:00:00.000Z");
    const createAndPublish = vi.fn(async () => ({ productId: "pfy-human-wait", blueprintId: 42, printProviderId: 7 }));
    adapters.getPrintifyAdapter.mockResolvedValue({
      mode: "live",
      createAndPublish,
      getExternalEtsyIds: vi.fn(async () => ({})),
      getOrderStatuses: vi.fn(async () => ({})),
    });
    const result = await publishPodListingToEtsy(db, row.id, now);
    expect(result).toEqual({ ok: true, status: "publishing", etsyListingId: null });
    expect(createAndPublish).toHaveBeenCalledWith(expect.objectContaining({ publishToEtsy: true, existingProductId: "pfy-human-wait" }));
    const [after] = await db.select().from(listings).where(eq(listings.id, row.id));
    expect(after.status).toBe("publishing");
    expect(after.etsyListingId).toBeNull();
    expect(after.publishError).toBeNull();
    expect(after.podPublishedAt).toEqual(now);
    expect(after.publishedAt).toBeNull();
    expect((await db.select().from(costs)).length).toBe(before);
  });

  it("human publish with an external Etsy id is published", async () => {
    const row = await createdPod("pfy-human-id");
    adapters.getPrintifyAdapter.mockResolvedValue({
      mode: "live",
      createAndPublish: vi.fn(async () => ({ productId: "pfy-human-id", externalEtsyId: "1234567890", blueprintId: 42, printProviderId: 7 })),
      getExternalEtsyIds: vi.fn(async () => ({})),
      getOrderStatuses: vi.fn(async () => ({})),
    });
    const result = await publishPodListingToEtsy(db, row.id);
    expect(result.ok).toBe(true);
    const [after] = await db.select().from(listings).where(eq(listings.id, row.id));
    expect(after.status).toBe("published");
    expect(after.etsyListingId).toBe("1234567890");
    expect(after.podPublishedAt).toBeTruthy();
  });

  it("dry-run human publish mints a synthetic Etsy id", async () => {
    const row = await createdPod("dry-pfy-status");
    adapters.getPrintifyAdapter.mockResolvedValue({
      mode: "dry-run",
      createAndPublish: vi.fn(async () => ({ productId: "dry-pfy-status", blueprintId: 42, printProviderId: 7 })),
      getExternalEtsyIds: vi.fn(async () => ({})),
      getOrderStatuses: vi.fn(async () => ({})),
    });
    const result = await publishPodListingToEtsy(db, row.id);
    expect(result).toMatchObject({ ok: true, status: "published", etsyListingId: "dry-etsy-dry-pfy-status" });
    const [after] = await db.select().from(listings).where(eq(listings.id, row.id));
    expect(after.status).toBe("published");
    expect(after.etsyListingId).toBe("dry-etsy-dry-pfy-status");
  });
});
