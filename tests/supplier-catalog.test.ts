import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { quoteEnabledProducts, storeSupplierProduct } from "@/adapters/supplier/catalog";
import { GelatoDryRunSupplier } from "@/adapters/supplier/gelato-dryrun";
import type { SupplierProduct } from "@/adapters/supplier/types";
import { getDb } from "@/db";
import { supplierProducts } from "@/db/schema";
import { round2, usdToChf } from "@/lib/fees";

const product: SupplierProduct = {
  supplier: "gelato", preset: "tote", uid: "catalog-fixture-tote", title: "Tote",
  baseCostUsd: null, currency: null, sourceUrl: "https://product.gelatoapis.com/v3/catalogs", fetchedAt: new Date(),
};

describe("supplier catalog persistence", () => {
  it("stores source and timestamp, updates the unique catalog row, and skips synthetic ids", async () => {
    const db = await getDb();
    await storeSupplierProduct(db, product);
    await storeSupplierProduct(db, { ...product, baseCostUsd: 12, currency: "USD" });
    const rows = await db.select().from(supplierProducts).where(eq(supplierProducts.externalProductUid, product.uid));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ baseCostUsd: 12, sourceUrl: product.sourceUrl });
    expect(rows[0].fetchedAt).toBeInstanceOf(Date);
    await storeSupplierProduct(db, { ...product, uid: "dry-fixture" });
    expect(await db.select().from(supplierProducts).where(eq(supplierProducts.externalProductUid, "dry-fixture"))).toHaveLength(0);
  });

  it("quotes only the chosen supplier and rejects unknown or invalid landed costs", async () => {
    const db = await getDb();
    const supplier = new GelatoDryRunSupplier();
    supplier.listProducts = async () => [product];
    const notes: string[] = [];
    const settings = { enabledPresets: ["tote" as const], suppliers: { tote: "gelato" as const } };
    expect((await quoteEnabledProducts(db, settings, [supplier], (text) => notes.push(text))).costs.tote).toBeNull();
    expect(notes.join(" ")).toContain("unverified");
    supplier.quote = async () => ({ baseCostUsd: 12, shippingUsd: 4, inStock: true, productionDays: 3, currency: "USD", sourceUrl: product.sourceUrl, fetchedAt: new Date() });
    expect((await quoteEnabledProducts(db, settings, [supplier], () => {})).costs.tote).toBe(round2(usdToChf(16)));
    supplier.quote = async () => ({ baseCostUsd: NaN, shippingUsd: 4, inStock: true, productionDays: 3, currency: "USD", sourceUrl: product.sourceUrl, fetchedAt: new Date() });
    expect((await quoteEnabledProducts(db, settings, [supplier], () => {})).costs.tote).toBeNull();
    expect((await quoteEnabledProducts(db, settings, [], () => {})).costs.tote).toBeNull();
  });
});
