import { isPodPreset, type PodPreset } from "./fees";

export type PrintifyPin = { blueprintId: number; printProviderId: number; variantIds: number[] };

export function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Invalid pins must never silently fall back to a different physical product. */
export function parsePrintifyPresets(raw: string | undefined): Partial<Record<PodPreset, PrintifyPin>> {
  if (!raw) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("PRINTIFY_PRESETS_JSON must be a JSON object of preset pins"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("PRINTIFY_PRESETS_JSON must be a JSON object of preset pins");
  const out: Partial<Record<PodPreset, PrintifyPin>> = {};
  for (const [preset, value] of Object.entries(parsed)) {
    if (!isPodPreset(preset)) throw new Error("PRINTIFY_PRESETS_JSON has an unknown preset key");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid Printify pin for ${preset}`);
    const pin = value as Record<string, unknown>;
    if (Object.keys(pin).some((key) => !["blueprintId", "printProviderId", "variantIds"].includes(key))
      || !positiveId(pin.blueprintId) || !positiveId(pin.printProviderId)
      || !Array.isArray(pin.variantIds) || !pin.variantIds.length || !pin.variantIds.every(positiveId)
      || new Set(pin.variantIds).size !== pin.variantIds.length) throw new Error(`Invalid Printify pin for ${preset}: positive blueprintId, printProviderId and unique variantIds required`);
    out[preset] = { blueprintId: pin.blueprintId, printProviderId: pin.printProviderId, variantIds: [...pin.variantIds] };
  }
  return out;
}
