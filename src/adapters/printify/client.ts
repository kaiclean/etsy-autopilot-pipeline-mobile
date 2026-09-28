import type { PodPreset } from "@/lib/fees";
import { config } from "@/lib/config";
import { describeFetchError } from "@/lib/http-error";
import { placeholderPng } from "@/lib/png";
import { blueprintRows, pickBlueprint, pickProvider, pickVariantIds, providerRows, variantRows, type CatalogChoice } from "./catalog";
import type { PrintifyAdapter, PrintifyOrderStatus, PrintifyProductInput } from "./types";

const API = "https://api.printify.com/v1";

export class PrintifyPublishError extends Error {
  constructor(
    message: string,
    readonly productId: string,
  ) {
    super(message);
    this.name = "PrintifyPublishError";
  }
}

export class PrintifyLiveClient implements PrintifyAdapter {
  readonly mode = "live" as const;
  private blueprints: ReturnType<typeof blueprintRows> | null = null;
  private choices = new Map<PodPreset, CatalogChoice>();

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const method = init.method ?? "GET";
    let res: Response;
    try {
      res = await fetch(`${API}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${config.printify.token}`,
          "Content-Type": "application/json",
          "User-Agent": "EtsyAutopilot",
          ...(init.headers ?? {}),
        },
      });
    } catch (error) {
      throw describeFetchError(error, `Printify ${method} ${path}`);
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`Printify ${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  private envChoice(): CatalogChoice | undefined {
    const { blueprintId, printProviderId, variantIds } = config.printify;
    if (!blueprintId || !printProviderId || variantIds.length === 0) return undefined;
    return { blueprintId, printProviderId, variantIds };
  }

  private async choiceFor(preset: PodPreset): Promise<CatalogChoice> {
    const cached = this.choices.get(preset);
    if (cached) return cached;
    if (!this.blueprints) this.blueprints = blueprintRows(await this.request<unknown>("/catalog/blueprints.json"));
    const blueprint = pickBlueprint(preset, this.blueprints);
    if (!blueprint) throw new Error(`Printify catalog has no ${preset} product. Set PRINTIFY_BLUEPRINT_ID, PRINTIFY_PRINT_PROVIDER_ID and PRINTIFY_VARIANT_IDS to override.`);
    const providers = providerRows(await this.request<unknown>(`/catalog/blueprints/${blueprint.id}/print_providers.json`));
    const provider = pickProvider(providers);
    if (!provider) throw new Error(`Printify blueprint ${blueprint.id} (${blueprint.title}) has no print provider.`);
    const variants = variantRows(
      await this.request<unknown>(`/catalog/blueprints/${blueprint.id}/print_providers/${provider.id}/variants.json`),
    );
    const variantIds = pickVariantIds(preset, variants);
    if (variantIds.length === 0) throw new Error(`Printify blueprint ${blueprint.id} / provider ${provider.id} has no ${preset} variant.`);
    const choice = { blueprintId: blueprint.id, printProviderId: provider.id, variantIds };
    this.choices.set(preset, choice);
    return choice;
  }

  private async uploadDesign(imageUrl: string) {
    const png = placeholderPng(imageUrl);
    const body = png
      ? { file_name: "design.png", contents: png.toString("base64") }
      : { file_name: `design-${Date.now()}.png`, url: imageUrl };
    return this.request<{ id: string }>("/uploads/images.json", { method: "POST", body: JSON.stringify(body) });
  }

  private async publishProduct(shopId: string, productId: string) {
    await this.request(`/shops/${shopId}/products/${productId}/publish.json`, {
      method: "POST",
      body: JSON.stringify({ title: true, description: true, images: true, variants: true, tags: true, keyFeatures: true, shipping_template: true }),
    });
  }

  async createAndPublish(input: PrintifyProductInput) {
    const shopId = config.printify.shopId;
    if (!shopId) throw new Error("PRINTIFY_SHOP_ID missing");
    if (input.existingProductId) {
      try {
        await this.publishProduct(shopId, input.existingProductId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new PrintifyPublishError(message, input.existingProductId);
      }
      return { productId: input.existingProductId };
    }
    const choice = this.envChoice() ?? (input.preset ? await this.choiceFor(input.preset) : undefined);
    if (!choice) throw new Error("POD listing is missing its Printify preset");
    const upload = await this.uploadDesign(input.imageUrl);
    const priceCents = Math.round(input.priceChf * 100);
    const product = await this.request<{ id: string }>(`/shops/${shopId}/products.json`, {
      method: "POST",
      body: JSON.stringify({
        title: input.title,
        description: input.description,
        tags: input.tags,
        blueprint_id: choice.blueprintId,
        print_provider_id: choice.printProviderId,
        variants: choice.variantIds.map((id) => ({ id, price: priceCents, is_enabled: true })),
        print_areas: [
          {
            variant_ids: choice.variantIds,
            placeholders: [{ position: "front", images: [{ id: upload.id, x: 0.5, y: 0.5, scale: 1, angle: 0 }] }],
          },
        ],
      }),
    });
    try {
      await this.publishProduct(shopId, product.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new PrintifyPublishError(message, product.id);
    }
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
