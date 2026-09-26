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
    this.calls.push({ op: "createProduct", payload: input });
    this.calls.push({ op: "publishProduct", payload: { title: true, description: true, images: true, variants: true, tags: true } });
    return { productId: `dry-pfy-${Date.now().toString(36)}${Math.floor(this.random() * 1e4)}` };
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
