import { hasGelatoCredentials, hasPrintifyCredentials } from "@/lib/config";
import { GelatoSupplier } from "./gelato";
import { PrintifySupplier } from "./printify";
import type { Supplier } from "./types";

/** Optional providers are not exposed until their credentials are configured. */
export function getSuppliers(): Supplier[] {
  const suppliers: Supplier[] = [];
  if (hasPrintifyCredentials()) suppliers.push(new PrintifySupplier());
  if (hasGelatoCredentials()) suppliers.push(new GelatoSupplier());
  return suppliers;
}

export type { Supplier, SupplierId, SupplierProduct, SupplierQuote } from "./types";
