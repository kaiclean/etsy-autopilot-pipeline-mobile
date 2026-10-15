import type { components } from "./generated";

type TaxonomyNode = components["schemas"]["SellerTaxonomyNode"];
type TaxonomyProperty = components["schemas"]["TaxonomyNodeProperty"];

export function findSellerTaxonomy(nodes: TaxonomyNode[], id: number, depth = 0): TaxonomyNode | undefined {
  if (depth > 20 || !Number.isSafeInteger(id) || id <= 0) return undefined;
  for (const node of nodes) {
    if (node.id === id) return node;
    const child = Array.isArray(node.children) ? findSellerTaxonomy(node.children, id, depth + 1) : undefined;
    if (child) return child;
  }
}

/** Direct inventory writes are deliberately absent. These checks describe valid future mappings only. */
export function validateVariationScales(
  products: { propertyValues: { propertyId: number; scaleId?: number; valueIds?: number[] }[] }[],
  properties: TaxonomyProperty[],
) {
  const used = new Map<number, number>();
  for (const product of products) {
    for (const value of product.propertyValues) {
      const property = properties.find((p) => p.property_id === value.propertyId && p.supports_variations === true);
      if (!property) throw new Error("Variation property is not supported by this taxonomy");
      if (property.scales?.length) {
        if (!Number.isSafeInteger(value.scaleId) || !property.scales.some((s) => s.scale_id === value.scaleId)) {
          throw new Error("Variation needs a valid taxonomy scale id");
        }
        const previous = used.get(value.propertyId);
        if (previous != null && previous !== value.scaleId) throw new Error("Variation scale ids must be consistent across products");
        used.set(value.propertyId, value.scaleId!);
      }
      if (value.valueIds?.some((id) => !property.possible_values?.some((v) => v.value_id === id))) {
        throw new Error("Variation value is not available in this taxonomy");
      }
    }
  }
}
