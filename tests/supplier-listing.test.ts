import path from "node:path";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSuppliers } from "@/adapters/supplier";
import { GelatoDryRunSupplier } from "@/adapters/supplier/gelato-dryrun";
import type { Supplier } from "@/adapters/supplier/types";
import { setLLMProviderForTests } from "@/adapters/llm";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { DEFAULT_POD_PRESETS, POD_PRESETS, usdToChf, type PodPreset } from "@/lib/fees";
import * as fileManifest from "@/lib/file-manifest";
import { setSetting } from "@/lib/settings";
import { runStage } from "@/pipeline/runner";
import { refreshSourcing } from "@/pipeline/sourcing";
import { runListing } from "@/pipeline/listing";

vi.mock("@/adapters/supplier", () => ({ getSuppliers: vi.fn(() => []) }));
afterEach(() => {
  vi.mocked(getSuppliers).mockReset().mockReturnValue([]);
  setLLMProviderForTests(null);
  vi.restoreAllMocks();
});

describe("listing supplier selection", () => {
  it.each([
    ...DEFAULT_POD_PRESETS.map((preset) => ({ preset, supplierId: "printify" as const, held: false })),
    { preset: "mug" as PodPreset, supplierId: "gelato" as const, held: true },
    { preset: "tote" as PodPreset, supplierId: "printify" as const, held: true },
  ])("preserves listing eligibility for fresh sourced $supplierId:$preset", async ({ preset, supplierId, held }) => {
    const client = new PGlite("memory://");
    try {
      const db = drizzle(client, { schema }) as DB;
      await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
      await client.exec(readFileSync(path.join(process.cwd(), "drizzle/0016_sourcing.sql"), "utf8"));
      await setSetting(db, "podProducts", { enabledPresets: [preset], suppliers: {} });
      const [shop] = await db.select().from(schema.shops).limit(1);
      await db.insert(schema.designs).values({
        shopId: shop.id, niche: "alpine", prompt: "Mountain", provider: "fixture",
        imageUrl: "https://cdn.example/artwork.png", imageWidth: 4000, imageHeight: 6000,
        colorVariance: 20, qualityScore: 8, qualityReasons: [], isDemo: false,
      });
      setLLMProviderForTests({
        name: "fixture",
        writeListing: async (brief) => ({
          title: `Mountain ${brief.productType === "pod" ? POD_PRESETS[brief.podPreset!].label : "Digital Download"}`,
          tags: Array.from({ length: 13 }, (_, i) => `mountain gift ${i}`),
          body: "Original mountain design.", provider: "fixture", costChf: 0,
        }),
      });
      vi.spyOn(fileManifest, "buildFileManifest").mockResolvedValue(null);
      const now = new Date();
      const supplier: Supplier = {
        id: supplierId, mode: "dry-run",
        listProducts: async () => [{
          supplier: supplierId, preset, uid: "101:201:301", title: POD_PRESETS[preset].label,
          baseCostUsd: null, currency: null, sourceUrl: "https://api.printify.com/v1/catalog", fetchedAt: now,
        }],
        quote: async () => ({
          baseCostUsd: 9, shippingUsd: 3, inStock: true, productionDays: 3,
          currency: "USD", sourceUrl: "https://api.printify.com/v1/catalog", fetchedAt: now,
        }),
        createProduct: vi.fn(async () => { throw new Error("Supplier writes prohibited"); }),
        getOrderStatuses: async () => ({}),
      };
      const ctx = { db, now, shopId: shop.id, demo: false, log: vi.fn(), trigger: "manual" as const, random: () => 0 };
      await refreshSourcing(ctx, [supplier]);
      await runListing(ctx);
      const pod = (await db.select().from(schema.listings)).find((listing) => listing.productType === "pod")!;
      expect(pod).toMatchObject({
        podProvider: `${supplierId}:${preset}`, supplier: supplierId, supplierProductId: "101:201:301",
        podCostChf: usdToChf(12), status: held ? "quality_failed" : "pending_approval", isDemo: false,
      });
      expect(pod.validation.some((issue) => issue.code === "supplier_dry_run")).toBe(held);
      expect(pod.validation.some((issue) => issue.code === "sourcing_estimate")).toBe(false);
      expect(supplier.createProduct).not.toHaveBeenCalled();
    } finally { await client.close(); }
  });

  it.each(["default", "none", "unknown", "quoted"] as const)("preserves safe behavior for %s settings", async (caseName) => {
    const client = new PGlite("memory://");
    try {
      const db = drizzle(client, { schema }) as DB;
      await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
      await db.insert(schema.designs).values({ niche: "alpine", prompt: "Mountain", provider: "mock", imageUrl: "/api/placeholder/1?niche=alpine", isDemo: true });
      if (caseName !== "default") {
        await setSetting(db, "podProducts", {
          enabledPresets: caseName === "none" ? [] : ["tote"],
          suppliers: { tote: "gelato" },
        });
      }
      if (caseName === "quoted") {
        const supplier = new GelatoDryRunSupplier();
        supplier.listProducts = async () => [{
          supplier: "gelato", preset: "tote", uid: "listing-fixture-tote", title: "Tote",
          baseCostUsd: 10, currency: "USD", sourceUrl: "https://product.gelatoapis.com/v3/catalogs", fetchedAt: new Date(),
        }];
        supplier.quote = async () => ({ baseCostUsd: 10, shippingUsd: 4, inStock: true, productionDays: 3, currency: "USD", sourceUrl: "https://product.gelatoapis.com/v3/catalogs", fetchedAt: new Date() });
        vi.mocked(getSuppliers).mockReturnValue([supplier]);
        await client.exec(readFileSync(path.join(process.cwd(), "drizzle/0016_sourcing.sql"), "utf8"));
        await refreshSourcing({ db, now: new Date(), log: () => {}, shopId: "demo", demo: true });
        expect(getSuppliers).toHaveBeenCalledOnce();
      }
      await runStage("listing", "manual", { db });
      const rows = await db.select().from(schema.listings);
      expect(rows).toHaveLength(caseName === "default" ? 6 : caseName === "quoted" ? 3 : 2);
      const pods = rows.filter((row) => row.productType === "pod");
      if (caseName === "default") {
        expect(pods.map((row) => row.podProvider)).toEqual(DEFAULT_POD_PRESETS.map((preset) => `printify:${preset}`));
        expect(getSuppliers).not.toHaveBeenCalled();
      } else if (caseName === "quoted") {
        expect(getSuppliers).toHaveBeenCalledOnce();
        expect(pods[0]).toMatchObject({ podProvider: "gelato:tote", supplier: "gelato", supplierProductId: "listing-fixture-tote", status: "quality_failed" });
        expect(pods[0].validation.some((reason) => reason.code === "supplier_dry_run")).toBe(true);
        expect(await db.select().from(schema.supplierProducts)).toHaveLength(1);
      }
    } finally { await client.close(); }
  });
});
