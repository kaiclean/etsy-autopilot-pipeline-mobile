import path from "node:path";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSuppliers } from "@/adapters/supplier";
import { GelatoDryRunSupplier } from "@/adapters/supplier/gelato-dryrun";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { DEFAULT_POD_PRESETS } from "@/lib/fees";
import { setSetting } from "@/lib/settings";
import { runStage } from "@/pipeline/runner";
import { refreshSourcing } from "@/pipeline/sourcing";

vi.mock("@/adapters/supplier", () => ({ getSuppliers: vi.fn(() => []) }));
afterEach(() => { vi.mocked(getSuppliers).mockReset().mockReturnValue([]); });

describe("listing supplier selection", () => {
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
        await client.exec(readFileSync(path.join(process.cwd(), "drizzle/0015_sourcing.sql"), "utf8"));
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
