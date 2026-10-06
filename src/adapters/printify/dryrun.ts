import type { PrintifyAdapter, PrintifyOrderStatus, PrintifyProductInput } from "./types";

const NEXT: Record<PrintifyOrderStatus, PrintifyOrderStatus> = {
  pending: "in_production",
  in_production: "shipped",
  shipped: "delivered",
  delivered: "delivered",
};

export class PrintifyDryRunAdapter implements PrintifyAdapter {
  readonly mode = "dry-run" as const;
  readonly calls: { op: string; payload: unknown }[] = [];

  constructor(
    private random: () => number = Math.random,
    private known: Record<string, PrintifyOrderStatus> = {},
  ) {}

  async createAndPublish(input: PrintifyProductInput) {
    const blueprintId = input.blueprintId ?? 9001;
    const printProviderId = input.printProviderId ?? 9002;
    if (input.existingProductId && !input.publishToEtsy) {
      return { productId: input.existingProductId, blueprintId, printProviderId };
    }
    this.calls.push({ op: input.existingProductId ? "reuseProduct" : "createProduct", payload: input });
    if (input.publishToEtsy) {
      this.calls.push({ op: "publishProduct", payload: { title: true, description: true, images: true, variants: true, tags: true } });
    }
    if (input.existingProductId) return { productId: input.existingProductId, blueprintId, printProviderId };
    return { productId: `dry-pfy-${Date.now().toString(36)}${Math.floor(this.random() * 1e4)}`, blueprintId, printProviderId };
  }

  /** Dry-run products have no sales channel. Callers mint a synthetic Etsy id instead. */
  async getExternalEtsyIds(productIds: string[]) {
    return Object.fromEntries(productIds.map((id) => [id, null]));
  }

  /** Advances each simulated order one step with 60% probability per sync. */
  async getOrderStatuses(podOrderIds: string[]) {
    return Object.fromEntries(
      podOrderIds.map((id) => {
        const cur = this.known[id] ?? "pending";
        return [id, this.random() < 0.6 ? NEXT[cur] : cur];
      }),
    );
  }
}
