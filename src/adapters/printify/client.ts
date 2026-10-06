import type { PodPreset } from "@/lib/fees";
import { config } from "@/lib/config";
import { describeFetchError } from "@/lib/http-error";
import { externalEtsyIdFromProduct } from "@/lib/pod-etsy-id";
import { localAssetPng } from "@/lib/png";
import { LIVE_PROVIDER_PIN_ERROR } from "@/lib/publish-gates";
import type { CatalogChoice } from "./catalog";
import type { PrintifyAdapter, PrintifyOrderStatus, PrintifyProductInput } from "./types";

const API = "https://api.printify.com/v1";

export type PrintifyWebhookRef = { topic: string; url: string };

function webhookRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const rec = payload as Record<string, unknown>;
  if (Array.isArray(rec.data)) return rec.data;
  if (Array.isArray(rec.webhooks)) return rec.webhooks;
  return [];
}

/** Topic and URL only. Printify includes `secret` on webhook rows; it is dropped here. */
export function toPrintifyWebhookRefs(payload: unknown): PrintifyWebhookRef[] {
  const refs: PrintifyWebhookRef[] = [];
  for (const row of webhookRows(payload)) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const topic = typeof rec.topic === "string" ? rec.topic.trim() : "";
    const url = typeof rec.url === "string" ? rec.url.trim() : "";
    if (!topic || !url) continue;
    refs.push({ topic, url });
  }
  return refs;
}

function redactPrintifyError(error: unknown, secrets: Array<string | undefined>) {
  let message = error instanceof Error ? error.message : "Printify request failed";
  for (const secret of secrets) {
    if (secret) message = message.split(secret).join("[redacted]");
  }
  return new Error(message);
}

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

  /** Catalog scoring stays in catalog.ts. Live creation never calls pickProvider. */
  private async choiceFor(preset: PodPreset): Promise<CatalogChoice> {
    throw new Error(`${LIVE_PROVIDER_PIN_ERROR} Blocked preset: ${preset}.`);
  }

  private async uploadDesign(imageUrl: string) {
    const png = localAssetPng(imageUrl);
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

  /** GET the product. Printify fills `external.id` only after Etsy accepts the publish. */
  private async readExternalEtsyId(shopId: string, productId: string) {
    const product = await this.request<unknown>(`/shops/${shopId}/products/${productId}.json`);
    return externalEtsyIdFromProduct(product);
  }

  private async externalIdAfterPublish(shopId: string, productId: string) {
    try {
      return (await this.readExternalEtsyId(shopId, productId)) ?? undefined;
    } catch {
      return undefined;
    }
  }

  async createAndPublish(input: PrintifyProductInput) {
    const shopId = config.printify.shopId;
    if (!shopId) throw new Error("PRINTIFY_SHOP_ID missing");
    if (input.existingProductId) {
      if (!input.publishToEtsy) {
        return {
          productId: input.existingProductId,
          blueprintId: input.blueprintId,
          printProviderId: input.printProviderId,
        };
      }
      try {
        await this.publishProduct(shopId, input.existingProductId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new PrintifyPublishError(message, input.existingProductId);
      }
      const externalEtsyId = await this.externalIdAfterPublish(shopId, input.existingProductId);
      return {
        productId: input.existingProductId,
        blueprintId: input.blueprintId,
        printProviderId: input.printProviderId,
        ...(externalEtsyId ? { externalEtsyId } : {}),
      };
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
    let externalEtsyId: string | undefined;
    if (input.publishToEtsy) {
      try {
        await this.publishProduct(shopId, product.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new PrintifyPublishError(message, product.id);
      }
      externalEtsyId = await this.externalIdAfterPublish(shopId, product.id);
    }
    return {
      productId: product.id,
      blueprintId: choice.blueprintId,
      printProviderId: choice.printProviderId,
      ...(externalEtsyId ? { externalEtsyId } : {}),
    };
  }

  async getExternalEtsyIds(productIds: string[]) {
    const shopId = config.printify.shopId;
    if (!shopId) throw new Error("PRINTIFY_SHOP_ID missing");
    const out: Record<string, string | null> = {};
    for (const id of productIds) {
      try {
        out[id] = await this.readExternalEtsyId(shopId, id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[printify] could not read external id for ${id}: ${message}`);
      }
    }
    return out;
  }

  async listWebhooks(): Promise<PrintifyWebhookRef[]> {
    const shopId = config.printify.shopId;
    if (!shopId) throw new Error("PRINTIFY_SHOP_ID missing");
    try {
      const payload = await this.request<unknown>(`/shops/${shopId}/webhooks.json`);
      return toPrintifyWebhookRefs(payload);
    } catch (error) {
      throw redactPrintifyError(error, [config.printify.token, config.printify.webhookSecret]);
    }
  }

  async createWebhook(input: { topic: string; url: string; secret: string }) {
    const shopId = config.printify.shopId;
    if (!shopId) throw new Error("PRINTIFY_SHOP_ID missing");
    try {
      const created = await this.request<{ id?: string; topic?: string }>(`/shops/${shopId}/webhooks.json`, {
        method: "POST",
        body: JSON.stringify({ topic: input.topic, url: input.url, secret: input.secret }),
      });
      return { id: created?.id, topic: created?.topic ?? input.topic };
    } catch (error) {
      throw redactPrintifyError(error, [input.secret, config.printify.token]);
    }
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
