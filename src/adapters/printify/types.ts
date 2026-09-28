import type { PodPreset } from "@/lib/fees";

export type PrintifyProductInput = {
  title: string;
  description: string;
  tags: string[];
  priceChf: number;
  imageUrl: string;
  /** Which POD blank to resolve from the Printify catalog when env blueprint ids are unset. */
  preset?: PodPreset;
  /** Retry a product that was created but not published. */
  existingProductId?: string;
};

export type PrintifyOrderStatus = "pending" | "in_production" | "shipped" | "delivered";

export interface PrintifyAdapter {
  readonly mode: "dry-run" | "live";
  /** Uploads the design, creates the product and publishes it to the connected Etsy shop. */
  createAndPublish(input: PrintifyProductInput): Promise<{ productId: string; externalEtsyId?: string }>;
  getOrderStatuses(podOrderIds: string[]): Promise<Record<string, PrintifyOrderStatus>>;
}
