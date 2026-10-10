import type { DB } from "@/db";
import { supplierProducts } from "@/db/schema";
import { round2, usdToChf, type PodPreset } from "@/lib/fees";
import type { PodProductSettings } from "@/lib/settings";
import type { Supplier, SupplierProduct } from "./types";

export async function storeSupplierProduct(db: DB, product: SupplierProduct) {
  if (product.uid.startsWith("dry-")) return;
  const values = {
    supplier: product.supplier, preset: product.preset, externalProductUid: product.uid,
    title: product.title, baseCostUsd: product.baseCostUsd, currency: product.currency,
    sourceUrl: product.sourceUrl, fetchedAt: product.fetchedAt,
  };
  await db.insert(supplierProducts).values(values).onConflictDoUpdate({
    target: [supplierProducts.supplier, supplierProducts.preset, supplierProducts.externalProductUid],
    set: values,
  });
}

/** Read only the explicitly selected supplier. Unknown landed costs cannot become prices. */
export async function quoteEnabledProducts(db: DB, settings: PodProductSettings, suppliers: Supplier[], log: (message: string) => void) {
  const costs: Partial<Record<PodPreset, number | null>> = {};
  const products: Partial<Record<PodPreset, SupplierProduct>> = {};
  for (const preset of settings.enabledPresets) {
    const id = settings.suppliers[preset] ?? "printify";
    const supplier = suppliers.find((item) => item.id === id);
    costs[preset] = null;
    if (!supplier) { log(`${id}:${preset} skipped: supplier is not configured.`); continue; }
    try {
      const [product] = await supplier.listProducts(preset);
      if (!product) { log(`${id}:${preset} skipped: no catalog match.`); continue; }
      await storeSupplierProduct(db, product);
      const quote = await supplier.quote(product, "CH");
      await storeSupplierProduct(db, {
        ...product, baseCostUsd: quote.baseCostUsd, currency: quote.currency,
        sourceUrl: quote.sourceUrl, fetchedAt: quote.fetchedAt,
      });
      if (quote.baseCostUsd == null || quote.shippingUsd == null ||
        !Number.isFinite(quote.baseCostUsd) || !Number.isFinite(quote.shippingUsd) ||
        quote.baseCostUsd < 0 || quote.shippingUsd < 0) {
        log(`${id}:${preset} skipped: unverified base/shipping cost (—).`);
        continue;
      }
      costs[preset] = round2(usdToChf(quote.baseCostUsd + quote.shippingUsd));
      products[preset] = product;
    } catch (error) {
      log(`${id}:${preset} catalog/quote unavailable: ${error instanceof Error ? error.message : "supplier request failed"}`);
    }
  }
  return { costs, products };
}
