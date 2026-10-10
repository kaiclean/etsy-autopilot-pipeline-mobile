import type { PodPreset } from "@/lib/fees";
import type { PrintifyOrderStatus, PrintifyProductInput } from "@/adapters/printify/types";

export type SupplierId = "printify" | "gelato";

/** Catalog metadata only: no artwork, image blobs, or customer data. */
export type SupplierProduct = {
  supplier: SupplierId;
  preset: PodPreset;
  uid: string;
  title: string;
  baseCostUsd: number | null;
  currency: string | null;
  sourceUrl: string;
  fetchedAt: Date;
  blueprintId?: number;
  printProviderId?: number;
  variantId?: number;
};

export type SupplierQuote = {
  baseCostUsd: number | null;
  shippingUsd: number | null;
  inStock: boolean | null;
  productionDays: number | null;
  currency: string;
  sourceUrl: string;
  fetchedAt: Date;
};

export type SupplierProductInput = PrintifyProductInput & {
  preset: PodPreset;
  product?: SupplierProduct;
};

export interface Supplier {
  readonly id: SupplierId;
  readonly mode: "dry-run" | "live";
  listProducts(preset?: PodPreset): Promise<SupplierProduct[]>;
  quote(product: SupplierProduct, region: string): Promise<SupplierQuote>;
  createProduct(input: SupplierProductInput): Promise<{ productId: string }>;
  getOrderStatuses(orderIds: string[]): Promise<Record<string, PrintifyOrderStatus>>;
}
