import { config } from "@/lib/config";
import type { PrintifyAdapter, PrintifyOrderStatus, PrintifyProductInput } from "./types";

const API = "https://api.printify.com/v1";

export class PrintifyLiveClient implements PrintifyAdapter {
  readonly mode = "live" as const;

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${config.printify.token}`,
        "Content-Type": "application/json",
        "User-Agent": "EtsyAutopilot",
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) throw new Error(`Printify ${init.method ?? "GET"} ${path} → ${res.status}: ${(await res.text()).slice(0, 400)}`);
    return (await res.json()) as T;
  }

  async createAndPublish(input: PrintifyProductInput) {
    const { shopId, blueprintId, printProviderId, variantIds } = config.printify;
    if (!blueprintId || !printProviderId || variantIds.length === 0) {
      throw new Error("Set PRINTIFY_BLUEPRINT_ID, PRINTIFY_PRINT_PROVIDER_ID and PRINTIFY_VARIANT_IDS");
    }
    const upload = await this.request<{ id: string }>("/uploads/images.json", {
      method: "POST",
      body: JSON.stringify({ file_name: `design-${Date.now()}.png`, url: input.imageUrl }),
    });
    const priceCents = Math.round(input.priceChf * 100);
    const product = await this.request<{ id: string }>(`/shops/${shopId}/products.json`, {
      method: "POST",
      body: JSON.stringify({
        title: input.title,
        description: input.description,
        tags: input.tags,
        blueprint_id: blueprintId,
        print_provider_id: printProviderId,
        variants: variantIds.map((id) => ({ id, price: priceCents, is_enabled: true })),
        print_areas: [
          {
            variant_ids: variantIds,
            placeholders: [{ position: "front", images: [{ id: upload.id, x: 0.5, y: 0.5, scale: 1, angle: 0 }] }],
          },
        ],
      }),
    });
    await this.request(`/shops/${shopId}/products/${product.id}/publish.json`, {
      method: "POST",
      body: JSON.stringify({ title: true, description: true, images: true, variants: true, tags: true, keyFeatures: true, shipping_template: true }),
    });
    return { productId: product.id };
  }

  async getOrderStatuses(podOrderIds: string[]) {
    const out: Record<string, PrintifyOrderStatus> = {};
    for (const id of podOrderIds) {
      const o = await this.request<{ status: string }>(`/shops/${config.printify.shopId}/orders/${id}.json`);
      out[id] =
        o.status === "fulfilled"
          ? "delivered"
          : o.status === "partially-fulfilled" || o.status === "shipped"
            ? "shipped"
            : o.status === "in-production" || o.status === "sending-to-production"
              ? "in_production"
              : "pending";
    }
    return out;
  }
}
