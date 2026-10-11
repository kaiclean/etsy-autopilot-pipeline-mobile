import type { Marketplace, MarketplaceListing, MarketplaceOrderOptions, MarketplaceVariant } from "./types";

export type ShopifyProductSetPayload = {
  query: string;
  variables: {
    synchronous: true;
    identifier?: { id: string };
    input: {
      title: string;
      descriptionHtml: string;
      tags: string[];
      status: "DRAFT";
      productOptions: { name: string; values: { name: string }[] }[];
      variants: {
        price: string;
        optionValues: MarketplaceVariant["optionValues"];
        inventoryItem: { requiresShipping: boolean };
      }[];
      files: { originalSource: string; contentType: "IMAGE"; alt?: string }[];
    };
  };
};

const PRODUCT_SET = `mutation ProductSetPreview($input: ProductSetInput!, $synchronous: Boolean!, $identifier: ProductSetIdentifiers) {
  productSet(input: $input, synchronous: $synchronous, identifier: $identifier) {
    product { id status }
    userErrors { field message }
  }
}`;

function price(value: number) {
  if (!Number.isFinite(value) || value < 0) throw new Error("Shopify preview requires a finite, non-negative CHF price");
  return value.toFixed(2);
}

function descriptionHtml(text: string) {
  const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return text.replace(/[&<>"']/g, (character) => entities[character]).replace(/\r\n?|\n/g, "<br>");
}

/** Pure payload preparation. No credentials, network, persistence, or simulated commerce. */
export class ShopifyDryRunAdapter implements Marketplace<ShopifyProductSetPayload> {
  readonly id = "shopify" as const;
  readonly mode = "dry-run" as const;

  async upsertListing(listing: MarketplaceListing) {
    price(listing.priceChf);
    if (listing.variants?.length === 0) throw new Error("Shopify preview variants must not be empty");
    const variants = listing.variants ?? [{ optionValues: [{ optionName: "Title", name: "Default Title" }] }];
    const options = new Map<string, Set<string>>();
    const combinations = new Set<string>();
    for (const variant of variants) {
      const names = variant.optionValues.map((value) => value.optionName);
      if (!names.length || names.length > 3 || new Set(names).size !== names.length ||
          variant.optionValues.some((value) => !value.optionName.trim() || !value.name.trim())) {
        throw new Error("Shopify preview requires one to three distinct named options per variant");
      }
      if (options.size && (names.length !== options.size || names.some((name) => !options.has(name)))) {
        throw new Error("Shopify preview variants must use the same options");
      }
      const combination = JSON.stringify([...variant.optionValues].sort((a, b) => a.optionName.localeCompare(b.optionName)));
      if (combinations.has(combination)) throw new Error("Shopify preview has duplicate variant options");
      combinations.add(combination);
      for (const { optionName, name } of variant.optionValues) {
        if (!options.has(optionName)) options.set(optionName, new Set());
        options.get(optionName)!.add(name);
      }
    }
    const payloadPreview: ShopifyProductSetPayload = {
      query: PRODUCT_SET,
      variables: {
        synchronous: true,
        ...(listing.externalId !== undefined ? { identifier: { id: listing.externalId } } : {}),
        input: {
          title: listing.title,
          descriptionHtml: descriptionHtml(listing.description),
          tags: [...listing.tags],
          status: "DRAFT",
          productOptions: [...options].map(([name, values]) => ({ name, values: [...values].map((value) => ({ name: value })) })),
          variants: variants.map((variant) => ({
            price: price(variant.priceChf ?? listing.priceChf),
            optionValues: variant.optionValues.map((value) => ({ ...value })),
            inventoryItem: { requiresShipping: listing.productType === "pod" },
          })),
          files: listing.images.map(({ url, alt }) => {
            const parsed = new URL(url);
            if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
              throw new Error("Shopify preview images require absolute HTTP(S) URLs without credentials");
            }
            return { originalSource: url, contentType: "IMAGE", ...(alt !== undefined ? { alt } : {}) };
          }),
        },
      },
    };
    return { externalId: listing.externalId ?? null, status: "draft" as const, payloadPreview };
  }

  async getListingStatus(externalId: string) {
    return { externalId, status: "unknown" as const };
  }

  async listOrders(options: MarketplaceOrderOptions) {
    void options;
    return [];
  }
}
