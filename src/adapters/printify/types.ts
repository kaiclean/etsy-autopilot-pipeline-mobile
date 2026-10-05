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

export interface PrintifyAdapter {
  readonly mode: "dry-run" | "live";
  /**
   * Uploads the design and creates the Printify product.
   * Calls publish.json only when `publishToEtsy` is set (a per-listing human action).
   */
  createAndPublish(input: PrintifyProductInput): Promise<{
    productId: string;
    externalEtsyId?: string;
    blueprintId?: number;
    printProviderId?: number;
  }>;
  getOrderStatuses(podOrderIds: string[]): Promise<Record<string, PrintifyOrderStatus>>;
}
