import { config } from "@/lib/config";
import { pickBlueprint, pickProvider, pickVariantIds, blueprintRows, providerRows, variantRows } from "@/adapters/printify/catalog";
import type { PodPreset } from "@/lib/fees";

export type PixelSize = { width: number; height: number };
export type PrintTarget = { minW: number; minH: number; targetW: number; targetH: number };
export type PrintTargetKey = PodPreset | "digital" | "digitalLarge";

const APPAREL = { minW: 3000, minH: 3600, targetW: 4500, targetH: 5400 };
const POSTER = { minW: 3508, minH: 4961, targetW: 3508, targetH: 4961 };
const MUG = { minW: 1200, minH: 1120, targetW: 2700, targetH: 1120 };
const SQUARE = { minW: 1200, minH: 1200, targetW: 2400, targetH: 2400 };

export const PRINT_TARGETS: Record<PrintTargetKey, PrintTarget> = {
  posterA3: POSTER,
  mug: MUG,
  tshirt: APPAREL,
  sweatshirt: APPAREL,
  tote: APPAREL,
  phoneCase: { minW: 1200, minH: 2400, targetW: 1800, targetH: 3600 },
  canvas: POSTER,
  sticker: SQUARE,
  blanket: APPAREL,
  hoodie: APPAREL,
  ornament: SQUARE,
  digital: { minW: 1, minH: 2048, targetW: 1365, targetH: 2048 },
  digitalLarge: { minW: 1, minH: 6000, targetW: 4800, targetH: 7200 },
};

const targetCache = new Map<PodPreset, Promise<PrintTarget>>();

function validPixels(value: unknown): value is PixelSize {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return Number.isInteger(row.width) && Number.isInteger(row.height) && Number(row.width) > 0 && Number(row.height) > 0;
}

function targetFromPlaceholder(width: number, height: number): PrintTarget {
  return {
    minW: Math.max(1, Math.floor(width * 0.66)),
    minH: Math.max(1, Math.floor(height * 0.66)),
    targetW: width,
    targetH: height,
  };
}

async function readPrintifyTarget(preset: PodPreset): Promise<PrintTarget> {
  const fallback = PRINT_TARGETS[preset];
  const { token, blueprintId, printProviderId, variantIds } = config.printify;
  if (!token) return fallback;
  const headers = { Authorization: ["Bearer", token].join(" "), "User-Agent": "EtsyAutopilot" };
  const get = async (path: string) => {
    const response = await fetch(`https://api.printify.com/v1${path}`, {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`Printify catalog HTTP ${response.status}`);
    return response.json() as Promise<unknown>;
  };
  try {
    const blueprints = blueprintId
      ? [{ id: blueprintId, title: "" }]
      : blueprintRows(await get("/catalog/blueprints.json"));
    const blueprint = blueprintId ? blueprints[0] : pickBlueprint(preset, blueprints);
    if (!blueprint) return fallback;
    const providers = printProviderId
      ? [{ id: printProviderId, title: "" }]
      : providerRows(await get(`/catalog/blueprints/${blueprint.id}/print_providers.json`));
    const provider = printProviderId ? providers[0] : pickProvider(providers);
    if (!provider) return fallback;
    const variants = variantRows(await get(`/catalog/blueprints/${blueprint.id}/print_providers/${provider.id}/variants.json?show-out-of-stock=1`));
    const selectedIds = variantIds.length ? variantIds : pickVariantIds(preset, variants);
    const variant = variants.find((row) => selectedIds.includes(row.id));
    const placeholders = variant?.placeholders as unknown;
    if (!Array.isArray(placeholders)) return fallback;
    const preferred = placeholders.find((row) => row?.position === "front") ?? placeholders[0];
    if (!validPixels(preferred)) return fallback;
    return targetFromPlaceholder(preferred.width, preferred.height);
  } catch {
    return fallback;
  }
}

/** Uses a fresh Printify catalog placeholder when available, with a stable local fallback. */
export function getPrintTarget(key: PrintTargetKey): Promise<PrintTarget> {
  if (key === "digital" || key === "digitalLarge") return Promise.resolve(PRINT_TARGETS[key]);
  let target = targetCache.get(key);
  if (!target) {
    target = readPrintifyTarget(key);
    targetCache.set(key, target);
  }
  return target;
}

export function hasMinimumPixels(width: number | null | undefined, height: number | null | undefined, target: Pick<PrintTarget, "minW" | "minH">) {
  if (!width || !height) return false;
  return (width >= target.minW && height >= target.minH) || (height >= target.minW && width >= target.minH);
}

export function clearPrintTargetCache() {
  targetCache.clear();
}

export function pixelSize(size: PixelSize | null | undefined) {
  return size ? `${size.width}×${size.height}px` : "unknown size";
}
