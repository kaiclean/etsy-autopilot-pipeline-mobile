import type { PodPreset } from "@/lib/fees";

export type PrintifyProductInput = {
  title: string;
  description: string;
  tags: string[];
  priceChf: number;
  imageUrl: string;
  /** Which POD blank this listing is for. Live creation still requires the env blueprint pin. */
  preset?: PodPreset;
  /** Retry a product that was created but not published to Etsy. */
  existingProductId?: string;
  /**
   * Human step. Cron must leave this false.
   * When false, an existing product is not sent to publish.json.
   */
  publishToEtsy?: boolean;
  blueprintId?: number;
  printProviderId?: number;
};

export type PrintifyOrderStatus = "pending" | "in_production" | "shipped" | "delivered";
export type PrintifyProviderDetails = {
  processingMin: number;
  processingMax: number;
  shippingMin: number;
  shippingMax: number;
};
export type PrintifyProductImage = {
  src: string;
  variant_ids?: number[];
  position?: string;
  is_default?: boolean;
  source?: "supplier" | "synthetic";
};

export interface PrintifyAdapter {
  readonly mode: "dry-run" | "live";
  getProviderDetails?(preset: PodPreset): Promise<PrintifyProviderDetails>;
  getProductImages?(productId: string): Promise<PrintifyProductImage[]>;
  /**
   * Uploads the design and creates the Printify product.
   * Calls publish.json only when `publishToEtsy` is set (a per-listing human action).
   * After that call, a live client may GET `external.id`. Create-only does not.
   */
  createAndPublish(input: PrintifyProductInput): Promise<{
    productId: string;
    externalEtsyId?: string;
    blueprintId?: number;
    printProviderId?: number;
    variantIds?: number[];
  }>;
  /**
   * Read-only. Maps a Printify product id to the Etsy listing id in `external.id`, or null
   * when Printify has not written it yet. A missing key means that product could not be read.
   */
  getExternalEtsyIds(productIds: string[]): Promise<Record<string, string | null>>;
  getOrderStatuses(podOrderIds: string[]): Promise<Record<string, PrintifyOrderStatus>>;
}
