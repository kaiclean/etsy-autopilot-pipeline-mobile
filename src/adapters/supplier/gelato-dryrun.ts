import { createHash } from "node:crypto";
import type { PrintifyOrderStatus } from "@/adapters/printify/types";
import type { Supplier, SupplierProduct, SupplierProductInput, SupplierQuote } from "./types";

/** No real catalog data or prices are fabricated by the simulation. */
export class GelatoDryRunSupplier implements Supplier {
  readonly id = "gelato" as const;
  readonly mode = "dry-run" as const;

  async listProducts(): Promise<SupplierProduct[]> {
    return [];
  }

  async quote(product: SupplierProduct, region: string): Promise<SupplierQuote> {
    if (product.supplier !== this.id || !/^[A-Z]{2}$/.test(region)) throw new Error("Invalid Gelato quote input");
    return { baseCostUsd: null, shippingUsd: null, inStock: null, productionDays: null, currency: "USD", sourceUrl: product.sourceUrl, fetchedAt: new Date() };
  }

  async createProduct(input: SupplierProductInput) {
    const hash = createHash("sha256").update(JSON.stringify([input.preset, input.title, input.imageUrl, input.product?.uid])).digest("hex").slice(0, 24);
    return { productId: `dry-gelato-${hash}` };
  }

  async getOrderStatuses(orderIds: string[]): Promise<Record<string, PrintifyOrderStatus>> {
    return Object.fromEntries(orderIds.map((id) => [id, "pending" as const]));
  }
}
