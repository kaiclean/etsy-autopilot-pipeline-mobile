import type { PrintifyAdapter, PrintifyOrderStatus, PrintifyProductImage, PrintifyProductInput } from "./types";
import type { PodPreset } from "@/lib/fees";

const PRESET_INDEX: Record<PodPreset, number> = {
  mug: 0, posterA3: 1, tshirt: 2, sweatshirt: 3, tote: 4, phoneCase: 5,
  canvas: 6, sticker: 7, blanket: 8, hoodie: 9, ornament: 10,
};

export function dryRunPrintifyPin(preset: PodPreset) {
  const offset = PRESET_INDEX[preset] * 10;
  return { blueprintId: 9001 + offset, printProviderId: 9002 + offset, variantIds: [9003 + offset] };
}

const NEXT: Record<PrintifyOrderStatus, PrintifyOrderStatus> = {
  pending: "in_production",
  in_production: "shipped",
  shipped: "delivered",
  delivered: "delivered",
};

export class PrintifyDryRunAdapter implements PrintifyAdapter {
  readonly mode = "dry-run" as const;
  readonly calls: { op: string; payload: unknown }[] = [];
  private products = new Map<string, PrintifyProductInput>();

  constructor(
    private random: () => number = Math.random,
    private known: Record<string, PrintifyOrderStatus> = {},
  ) {}

  async getProviderDetails(preset: PodPreset) {
    const index = PRESET_INDEX[preset];
    return { processingMin: 2 + index % 2, processingMax: 4 + index % 3, shippingMin: 3 + index % 2, shippingMax: 7 + index % 3 };
  }

  async getProductImages(productId: string): Promise<PrintifyProductImage[]> {
    if (!productId.startsWith("dry-")) return [];
    const product = this.products.get(productId);
    if (!product) return [];
    const preset = product.preset ?? "posterA3";
    return [1, 2, 3].map((index) => {
      const params = new URLSearchParams({ niche: `synthetic-demo-${index}`, synthetic: "true" });
      if (product.imageUrl && !product.imageUrl.startsWith("data:") && product.imageUrl.length <= 1800) params.set("src", product.imageUrl);
      return {
        src: `/api/mockup/${preset}?${params.toString()}`,
        source: "synthetic", position: `synthetic-demo-${index}`, is_default: index === 1,
        variant_ids: dryRunPrintifyPin(preset).variantIds,
      };
    });
  }

  async createAndPublish(input: PrintifyProductInput) {
    const fixture = dryRunPrintifyPin(input.preset ?? "posterA3");
    const blueprintId = input.blueprintId ?? fixture.blueprintId;
    const printProviderId = input.printProviderId ?? fixture.printProviderId;
    const variantIds = fixture.variantIds;
    const productId = input.existingProductId ?? `dry-pfy-${Date.now().toString(36)}${Math.floor(this.random() * 1e4)}`;
    if (productId.startsWith("dry-")) this.products.set(productId, input);
    if (input.existingProductId && !input.publishToEtsy) {
      return { productId: input.existingProductId, blueprintId, printProviderId, variantIds };
    }
    this.calls.push({ op: input.existingProductId ? "reuseProduct" : "createProduct", payload: input });
    if (input.publishToEtsy) {
      this.calls.push({ op: "publishProduct", payload: { title: true, description: true, images: true, variants: true, tags: true } });
    }
    if (input.existingProductId) return { productId: input.existingProductId, blueprintId, printProviderId, variantIds };
    return { productId, blueprintId, printProviderId, variantIds };
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
