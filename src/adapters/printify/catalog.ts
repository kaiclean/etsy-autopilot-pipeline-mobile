import type { PodPreset } from "@/lib/fees";
import type { PrintifyProviderDetails } from "./types";

export type BlueprintRow = { id: number; title: string };
export type ProviderRow = { id: number; title: string; production_time?: unknown };
export type PlaceholderRow = { position: string; width: number; height: number };
export type VariantRow = {
  id: number;
  title: string;
  options?: Record<string, string>;
  placeholders?: { position?: string; width?: number; height?: number }[];
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
  tote: { title: /\btote\b/i, avoid: /backpack|pouch/i, variant: /15\s*[x×]\s*16|one size|medium/i },
  phoneCase: { title: /phone case|tough case|snap case/i, avoid: /sleeve|wallet/i, variant: /iphone 15\b/i },
  canvas: { title: /\bcanvas\b/i, avoid: /framed|floating|bag/i, variant: /12\s*[x×]\s*18/i },
  sticker: { title: /\bstickers?\b/i, avoid: /sheet|roll/i, variant: /3\s*[x×]\s*3/i },
  blanket: { title: /\bblanket\b/i, avoid: /baby|hooded/i, variant: /50\s*[x×]\s*60/i },
  hoodie: { title: /hoodie|hooded sweatshirt/i, avoid: /youth|kids|zip/i, variant: /\bM\b|\bmedium\b/i },
  ornament: { title: /\bornaments?\b/i, avoid: /pack|set/i, variant: /round|circle/i },
};

export function matchesBlueprint(preset: PodPreset, row: BlueprintRow) {
  return RULES[preset].title.test(row.title) && !RULES[preset].avoid.test(row.title);
}

export function printPlaceholder(preset: PodPreset, variant: VariantRow): PlaceholderRow {
  const positions = preset === "mug" ? ["wrap", "full_wrap", "full", "front"]
    : preset === "phoneCase" ? ["back", "front"] : ["front"];
  for (const position of positions) {
    const area = variant.placeholders?.find((row) => row.position === position);
    if (area && typeof area.width === "number" && Number.isSafeInteger(area.width) && area.width > 0
      && typeof area.height === "number" && Number.isSafeInteger(area.height) && area.height > 0) {
      return { position, width: area.width, height: area.height };
    }
  }
  throw new Error(`No usable ${positions.join("/")} print placeholder for variant ${variant.id}`);
}

/** Printify scale is image width relative to the placeholder width, not source pixels. */
export function coverPlacement(art: { width: number; height: number }, area: PlaceholderRow) {
  const ratio = Math.max(area.width / art.width, area.height / art.height);
  if (ratio > 1) throw new Error(`Artwork would require upscaling for ${area.width}×${area.height} print area`);
  return { x: 0.5, y: 0.5, scale: Math.max(1, (art.width * area.height) / (art.height * area.width)), angle: 0 };
}

const EU_CH = new Set(["CH", "AT", "BE", "BG", "HR", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK"]);

function dayRange(value: unknown): { min: number; max: number } | undefined {
  if (!isRecord(value)) return undefined;
  if (value.unit !== undefined && value.unit !== "day" && value.unit !== "days" && value.unit !== "business-day" && value.unit !== "business_days") return undefined;
  const min = value.min ?? value.minimum ?? value.value;
  const max = value.max ?? value.maximum ?? value.value;
  if (typeof min !== "number" || typeof max !== "number" || !Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) return undefined;
  return { min: Math.floor(min), max: Math.ceil(max) };
}

function shippingProfiles(payload: unknown): Record<string, unknown>[] {
  return isRecord(payload) && Array.isArray(payload.profiles) ? payload.profiles.filter(isRecord) : [];
}

export function verifiedEuropeanShipping(payload: unknown, variantId: number) {
  return shippingProfiles(payload).filter((profile) => Array.isArray(profile.variant_ids) && profile.variant_ids.includes(variantId)
    && Array.isArray(profile.countries) && profile.countries.some((country) => typeof country === "string" && EU_CH.has(country))
    && dayRange(profile.delivery_time) !== undefined);
}

/** Do not substitute our margin/marketing estimates for supplier promises. */
export function providerDetails(provider: unknown, shipping: unknown, variantIds: number[]): PrintifyProviderDetails {
  const processing = isRecord(provider) ? dayRange(provider.production_time) : undefined;
  if (!processing) throw new Error("Printify provider production_time is missing or invalid");
  const ranges = variantIds.flatMap((id) => {
    const profiles = verifiedEuropeanShipping(shipping, id);
    if (!profiles.length) throw new Error(`Printify verified EU/CH delivery_time missing for variant ${id}`);
    return profiles.map((profile) => dayRange(profile.delivery_time)!);
  });
  if (!ranges.length) throw new Error("Printify supplier timings require pinned variants");
  return { processingMin: processing.min, processingMax: processing.max, shippingMin: Math.min(...ranges.map((r) => r.min)), shippingMax: Math.max(...ranges.map((r) => r.max)) };
}

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
      if (!rule.title.test(row.title) || rule.avoid.test(row.title)) return undefined;
      let score = 10;
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
  return `${row.title} ${Object.values(row.options ?? {}).join(" ")}`.replace(/["″]/g, "");
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
