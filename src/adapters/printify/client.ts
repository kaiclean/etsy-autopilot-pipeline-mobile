import type { PodPreset } from "@/lib/fees";
import { isSafeArtworkUrl } from "@/lib/art-quality";
import { validateArtwork } from "@/lib/artwork-codec";
import { loadArtworkBytes } from "@/lib/artwork-source";
import { config, resolvePrintifyPin } from "@/lib/config";
import { POD_PRESETS } from "@/lib/fees";
import { describeFetchError } from "@/lib/http-error";
import { externalEtsyIdFromProduct } from "@/lib/pod-etsy-id";
import { PRINT_TARGETS, hasMinimumPixels } from "@/lib/print-targets";
import { LIVE_PROVIDER_PIN_ERROR } from "@/lib/publish-gates";
import { coverPlacement, printPlaceholder, providerDetails, variantRows, type CatalogChoice } from "./catalog";
import type { PrintifyAdapter, PrintifyOrderStatus, PrintifyProductImage, PrintifyProductInput } from "./types";

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

  private choiceFor(preset: PodPreset): CatalogChoice {
    const pin = resolvePrintifyPin(preset);
    if (!pin) throw new Error(`No Printify blank pinned for ${POD_PRESETS[preset].label}. ${LIVE_PROVIDER_PIN_ERROR} Configure PRINTIFY_PRESETS_JSON (or PRINTIFY_PIN_PRESET and legacy IDs).`);
    return pin;
  }

  /** Upload exactly the bytes validated locally, including public URL sources. */
  private async uploadDesign(bytes: Buffer, format: string) {
    const body = { file_name: `design.${format}`, contents: bytes.toString("base64") };
    return this.request<{ id: string }>("/uploads/images.json", { method: "POST", body: JSON.stringify(body) });
  }

  async getProviderDetails(preset: PodPreset) {
    const choice = this.choiceFor(preset);
    const [provider, shipping] = await Promise.all([
      this.request<unknown>(`/catalog/print_providers/${choice.printProviderId}.json`),
      this.request<unknown>(`/catalog/blueprints/${choice.blueprintId}/print_providers/${choice.printProviderId}/shipping.json`),
    ]);
    return providerDetails(provider, shipping, choice.variantIds);
  }

  async getProductImages(productId: string): Promise<PrintifyProductImage[]> {
    const shopId = config.printify.shopId;
    if (!shopId) throw new Error("PRINTIFY_SHOP_ID missing");
    const product = await this.request<{ images?: PrintifyProductImage[] }>(`/shops/${encodeURIComponent(shopId)}/products/${encodeURIComponent(productId)}.json`);
    return (product.images ?? []).filter((image) => typeof image?.src === "string" && isSafeArtworkUrl(image.src));
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

  private async syncExistingProduct(shopId: string, input: PrintifyProductInput) {
    const path = `/shops/${encodeURIComponent(shopId)}/products/${encodeURIComponent(input.existingProductId!)}.json`;
    const current = await this.request<{
      blueprint_id?: number;
      print_provider_id?: number;
      variants?: { id: number; is_enabled: boolean }[];
    }>(path);
    if (!Array.isArray(current.variants) || !current.variants.length
      || current.variants.some((variant) => !Number.isSafeInteger(variant?.id) || variant.id <= 0 || typeof variant.is_enabled !== "boolean")) {
      throw new Error("Cannot synchronize existing Printify product: valid supplier variants are required");
    }
    await this.request(path, {
      method: "PUT",
      body: JSON.stringify({
        title: input.title,
        description: input.description,
        tags: input.tags,
      }),
    });
    return {
      productId: input.existingProductId!,
      blueprintId: current.blueprint_id ?? input.blueprintId,
      printProviderId: current.print_provider_id ?? input.printProviderId,
      variantIds: current.variants.filter((variant) => variant.is_enabled).map((variant) => variant.id),
    };
  }

  async createAndPublish(input: PrintifyProductInput) {
    const shopId = config.printify.shopId;
    if (!shopId) throw new Error("PRINTIFY_SHOP_ID missing");
    if (input.existingProductId) {
      const existing = await this.syncExistingProduct(shopId, input);
      if (!input.publishToEtsy) {
        return existing;
      }
      try {
        await this.publishProduct(shopId, input.existingProductId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new PrintifyPublishError(message, input.existingProductId);
      }
      const externalEtsyId = await this.externalIdAfterPublish(shopId, input.existingProductId);
      return {
        ...existing,
        ...(externalEtsyId ? { externalEtsyId } : {}),
      };
    }
    if (!input.preset) throw new Error("POD listing is missing its Printify preset");
    const choice = this.choiceFor(input.preset);
    const path = `/catalog/blueprints/${choice.blueprintId}/print_providers/${choice.printProviderId}`;
    const variants = variantRows(await this.request<unknown>(`${path}/variants.json`));
    const areas = choice.variantIds.map((id) => {
      const variant = variants.find((row) => row.id === id);
      if (!variant) throw new Error(`Pinned Printify variant ${id} is not in the selected blueprint/provider catalog`);
      return { id, area: printPlaceholder(input.preset!, variant) };
    });
    const bytes = await loadArtworkBytes(input.imageUrl);
    const art = bytes ? await validateArtwork(bytes) : null;
    if (!art || !bytes) throw new Error("Printify artwork could not be decoded; a real print file is required");
    const minimum = PRINT_TARGETS[input.preset];
    if (!hasMinimumPixels(art.width, art.height, minimum)) {
      throw new Error(`Printify ${input.preset} artwork is ${art.width}×${art.height}; minimum ${minimum.minW}×${minimum.minH} pixels required`);
    }
    const placements = areas.map(({ id, area }) => ({ id, area, placement: coverPlacement(art, area) }));
    const upload = await this.uploadDesign(bytes, art.format);
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
        print_areas: placements.map(({ id, area, placement }) => ({
          variant_ids: [id],
          placeholders: [{ position: area.position, images: [{ id: upload.id, ...placement }] }],
        })),
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
      variantIds: choice.variantIds,
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
