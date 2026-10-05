import type { PodPreset } from "@/lib/fees";

export type BlueprintRow = { id: number; title: string };
export type ProviderRow = { id: number; title: string };
export type VariantRow = {
  id: number;
  title: string;
  options?: Record<string, string>;
  placeholders?: { position?: string }[];
  /** Printify catalog cost in minor units when the provider includes it. */
  cost?: number;
};

export type CatalogChoice = {
  blueprintId: number;
  printProviderId: number;
  variantIds: number[];
};

const RULES: Record<PodPreset, { title: RegExp; avoid: RegExp; variant: RegExp }> = {
  posterA3: { title: /poster/i, avoid: /canvas|framed|metal|wood|acrylic/i, variant: /\bA3\b|297\s*[x×]\s*420|11\.7/i },
  mug: { title: /\bmug\b/i, avoid: /travel|tumbler|latte|magic/i, variant: /11\s?oz/i },
  tshirt: { title: /t-?shirt|\btee\b/i, avoid: /long sleeve|tank|youth|kids|toddler|baby|v-neck|polo|hoodie|sweat/i, variant: /\bM\b|\bmedium\b/i },
  sweatshirt: { title: /sweatshirt|crewneck/i, avoid: /hoodie|youth|kids|zip/i, variant: /\bM\b|\bmedium\b/i },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isBlueprint(value: unknown): value is BlueprintRow {
  return isRecord(value) && typeof value.id === "number" && typeof value.title === "string";
}

function isProvider(value: unknown): value is ProviderRow {
  return isRecord(value) && typeof value.id === "number" && typeof value.title === "string";
}

function isVariant(value: unknown): value is VariantRow {
  return isRecord(value) && typeof value.id === "number" && typeof value.title === "string";
}

export function blueprintRows(payload: unknown): BlueprintRow[] {
  return Array.isArray(payload) ? payload.filter(isBlueprint) : [];
}

export function providerRows(payload: unknown): ProviderRow[] {
  return Array.isArray(payload) ? payload.filter(isProvider) : [];
}

export function variantRows(payload: unknown): VariantRow[] {
  if (Array.isArray(payload)) return payload.filter(isVariant);
  if (isRecord(payload) && Array.isArray(payload.variants)) return payload.variants.filter(isVariant);
  return [];
}

/** Highest-scoring catalog blueprint for a shop preset. Stable when scores tie. */
export function pickBlueprint(preset: PodPreset, rows: BlueprintRow[]): BlueprintRow | undefined {
  const rule = RULES[preset];
  const ranked = rows
    .map((row) => {
      if (!rule.title.test(row.title)) return undefined;
      let score = 10;
      if (rule.avoid.test(row.title)) score -= 6;
      if (/unisex/i.test(row.title)) score += 3;
      if (score <= 0) return undefined;
      return { row, score };
    })
    .filter((item): item is { row: BlueprintRow; score: number } => item !== undefined)
    .sort((a, b) => b.score - a.score || a.row.id - b.row.id);
  return ranked[0]?.row;
}

export function pickProvider(rows: ProviderRow[]): ProviderRow | undefined {
  return rows.find((row) => /printify choice/i.test(row.title)) ?? rows[0];
}

function variantText(row: VariantRow) {
  return `${row.title} ${Object.values(row.options ?? {}).join(" ")}`;
}

const APPAREL_SIZES = ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL"] as const;

/**
 * Variants that should not share one retail price.
 * Posters and mugs stay on the single preset size. Apparel enables each adult size
 * (white when that color exists) so a larger blank can carry its own price.
 */
export function pickPricedVariantIds(preset: PodPreset, rows: VariantRow[]): number[] {
  if (preset !== "tshirt" && preset !== "sweatshirt") return pickVariantIds(preset, rows);
  const front = rows.filter((row) => !row.placeholders?.length || row.placeholders.some((item) => item.position === "front"));
  const pool = (front.length > 0 ? front : rows).filter((row) => !/youth|kids|toddler|baby/i.test(variantText(row)));
  const bySize = new Map<string, VariantRow[]>();
  for (const row of pool) {
    const size = variantText(row).match(/\b(5XL|4XL|3XL|2XL|XL|XS|S|M|L)\b/i)?.[1]?.toUpperCase();
    if (!size) continue;
    const list = bySize.get(size) ?? [];
    list.push(row);
    bySize.set(size, list);
  }
  if (bySize.size === 0) return pickVariantIds(preset, rows);
  const ids: number[] = [];
  for (const size of APPAREL_SIZES) {
    const group = bySize.get(size);
    if (!group?.length) continue;
    const white = group.find((row) => /white/i.test(variantText(row)));
    ids.push((white ?? group[0]).id);
  }
  return ids;
}

/** One enabled variant: the preset's size, white when that color exists, with a front print area. */
export function pickVariantIds(preset: PodPreset, rows: VariantRow[]): number[] {
  const rule = RULES[preset];
  const front = rows.filter((row) => !row.placeholders?.length || row.placeholders.some((item) => item.position === "front"));
  const pool = front.length > 0 ? front : rows;
  const sized = pool.filter((row) => rule.variant.test(variantText(row)));
  const chosen = sized.length > 0 ? sized : pool;
  const white = chosen.find((row) => /white/i.test(variantText(row)));
  const one = white ?? chosen[0];
  return one ? [one.id] : [];
}
