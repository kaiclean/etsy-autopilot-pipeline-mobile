/** How long a POD listing may sit without an Etsy id before the orders stage alerts once. */
export const ETSY_ID_WAIT_MS = 24 * 60 * 60 * 1000;

export type PodPublishResolution = {
  status: "published" | "publishing";
  etsyListingId: string | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/** Etsy listing ids are numeric. Dry-run ids are local stand-ins, never returned by Printify. */
export function isEtsyListingId(value: string | null | undefined): value is string {
  if (!value) return false;
  return /^\d{5,}$/.test(value.trim());
}

function etsyIdFromHandle(handle: string | undefined): string | null {
  if (!handle) return null;
  const match = handle.match(/\/listing\/(\d{5,})/);
  return match?.[1] ?? null;
}

function normalizeExternalId(value: unknown): string | null {
  const text = str(value);
  if (!text) return null;
  if (isEtsyListingId(text)) return text.trim();
  return etsyIdFromHandle(text);
}

function readExternal(external: unknown): string | null {
  if (Array.isArray(external)) {
    for (const item of external) {
      const id = readExternal(item);
      if (id) return id;
    }
    return null;
  }
  const rec = asRecord(external);
  return normalizeExternalId(rec.id) ?? etsyIdFromHandle(str(rec.handle));
}

/**
 * Printify product `external.id` is the sales-channel id. Etsy listings use a numeric id;
 * some payloads only put it in `external.handle`.
 */
export function externalEtsyIdFromProduct(payload: unknown): string | null {
  const root = asRecord(payload);
  return readExternal(root.external) ?? readExternal(asRecord(root.data).external) ?? etsyIdFromHandle(str(root.handle));
}

/**
 * A POD row is `published` only when it has an Etsy id. Live Printify publish is async, so
 * the usual result is `publishing` until a later read or webhook fills `external.id`.
 * Dry-run mints a synthetic id so local orders can still link.
 */
export function resolvePodPublish(input: {
  mode: "dry-run" | "live";
  productId: string;
  externalEtsyId?: string | null;
  previousEtsyListingId?: string | null;
}): PodPublishResolution {
  const external = normalizeExternalId(input.externalEtsyId);
  let result: PodPublishResolution;
  if (external) result = { status: "published", etsyListingId: external };
  else if (input.mode === "dry-run") result = { status: "published", etsyListingId: `dry-etsy-${input.productId}` };
  else {
    const previous = input.previousEtsyListingId?.trim() || null;
    if (previous && isEtsyListingId(previous)) result = { status: "published", etsyListingId: previous };
    else result = { status: "publishing", etsyListingId: null };
  }
  if (result.status === "published" && !result.etsyListingId) {
    throw new Error("POD publish invariant: published requires an Etsy listing id");
  }
  return result;
}
