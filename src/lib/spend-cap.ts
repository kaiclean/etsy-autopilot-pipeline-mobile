export function effectiveBusinessCap(cardCap: number | null, globalCap: number) {
  return Math.min(globalCap, cardCap ?? globalCap);
}

/** Global cap still applies across businesses. A business cap can only be tighter. */
export function spendAllowed(input: {
  spentGlobal: number;
  spentBusiness: number;
  globalCap: number;
  businessCap: number;
  nextCost: number;
}) {
  const globalBlocks = input.spentGlobal + input.nextCost > input.globalCap;
  const businessBlocks = input.spentBusiness + input.nextCost > input.businessCap;
  return { ok: !globalBlocks && !businessBlocks, globalBlocks, businessBlocks };
}

/** Missing or invalid config uses the global cap, so a one-business shop behaves as before. */
export function businessDailyAiCap(config: unknown, globalCap: number) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return globalCap;
  const value = (config as { dailyAiCapChf?: unknown }).dailyAiCapChf;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return globalCap;
  return value;
}

export function businessNumberFrom(config: unknown): number | null {
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  const value = (config as { businessNumber?: unknown }).businessNumber;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function boardFrom(config: unknown): string | null {
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  const value = (config as { board?: unknown }).board;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
