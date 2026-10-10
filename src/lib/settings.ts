import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import { settings } from "@/db/schema";
import type { StageName } from "@/db/schema";
import { DEFAULT_POD_PRESETS, isPodPreset, MARGIN_TARGETS, type PodPreset } from "@/lib/fees";
import { DEFAULT_PUSH_PREFS, type PushPrefs } from "@/lib/push-prefs";
import { defaultSourcingRegion, type SourcingRegion } from "@/lib/sourcing";

export type AutomationSettings = {
  killSwitch: boolean;
  dailyAiCapChf: number;
  monthlyAiBudgetChf: number;
  dailyAdsCapChf: number;
  adsEnabled: boolean;
  /**
   * Legacy single margin. Pricing ignores this and uses the per-type fields below,
   * so an old stored 55 does not push POD back onto niche ceilings.
   */
  targetMarginPct: number;
  /** Print-on-demand net margin. Default 30, clamped to 25–35. */
  podTargetMarginPct: number;
  /** Digital download net margin. Default 75, clamped to 75–85. */
  digitalTargetMarginPct: number;
  designsPerRun: number;
  assumeOffsiteAds: boolean;
  /** Runtime publish switch. Defaults to dry-run. Live is stored only after the confirm gate. */
  publishMode: "dry-run" | "live";
};

export type StageSettings = Record<StageName, { paused: boolean; cron: string }>;

export type PodProductSettings = {
  enabledPresets: PodPreset[];
  suppliers: Partial<Record<PodPreset, "printify" | "gelato">>;
};

export const DEFAULT_POD_PRODUCTS: PodProductSettings = {
  enabledPresets: [...DEFAULT_POD_PRESETS],
  suppliers: {},
};

/** Stored JSON is untrusted; absent fields preserve the existing four-product behavior. */
export function normalizePodProductSettings(value: unknown): PodProductSettings {
  const input = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const enabledPresets = Array.isArray(input.enabledPresets)
    ? [...new Set(input.enabledPresets.filter((preset): preset is PodPreset => typeof preset === "string" && isPodPreset(preset)))]
    : [...DEFAULT_POD_PRESETS];
  const suppliers: PodProductSettings["suppliers"] = {};
  if (input.suppliers && typeof input.suppliers === "object" && !Array.isArray(input.suppliers)) {
    for (const [preset, supplier] of Object.entries(input.suppliers)) {
      if (isPodPreset(preset) && (supplier === "printify" || supplier === "gelato")) suppliers[preset] = supplier;
    }
  }
  return { enabledPresets, suppliers };
}

export type EtsyTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  userId?: string;
  /** Set when the last refresh call failed. Cleared after a successful refresh. Never a token value. */
  refreshError?: string | null;
};

/** Review flag for the committed catalog diff. Pending stays true until Kai marks it reviewed. */
export type CatalogDraftSetting = {
  pending: boolean;
  reviewedByKai: boolean;
  source: string;
};

export const DEFAULT_CATALOG_DRAFT: CatalogDraftSetting = {
  pending: true,
  reviewedByKai: false,
  source: "Meridian + Listing package 2026-10-05",
};

export const DEFAULT_AUTOMATION: AutomationSettings = {
  killSwitch: false,
  dailyAiCapChf: 2,
  monthlyAiBudgetChf: 25,
  dailyAdsCapChf: 0.83,
  adsEnabled: false,
  targetMarginPct: MARGIN_TARGETS.podDefault,
  podTargetMarginPct: MARGIN_TARGETS.podDefault,
  digitalTargetMarginPct: MARGIN_TARGETS.digitalDefault,
  designsPerRun: 3,
  assumeOffsiteAds: false,
  publishMode: "dry-run",
};

/** Must match vercel.json cron entries (UTC). Daily cadence fits the Vercel Hobby plan. */
export const DEFAULT_STAGES: StageSettings = {
  research: { paused: false, cron: "0 5 * * 1" },
  design: { paused: false, cron: "0 6 * * *" },
  listing: { paused: false, cron: "30 6 * * *" },
  publish: { paused: false, cron: "0 7 * * *" },
  orders: { paused: false, cron: "0 8 * * *" },
  analytics: { paused: false, cron: "0 3 * * *" },
  maintenance: { paused: false, cron: "17 4 * * *" },
  daily: { paused: false, cron: "20 5 * * *" },
  health: { paused: false, cron: "0 9 * * 1" },
};

/** Where the next digital manifest backfill resumes, so rows that keep failing cannot block later ids. */
export type ManifestBackfillCursor = { afterId: number };

type SettingMap = {
  sourcing: { defaultRegion: SourcingRegion };
  automation: AutomationSettings;
  stages: StageSettings;
  etsyTokens: EtsyTokens | null;
  pushPrefs: PushPrefs;
  catalogDraft: CatalogDraftSetting;
  manifestBackfill: ManifestBackfillCursor;
  podProducts: PodProductSettings;
};

const DEFAULTS: SettingMap = {
  sourcing: { defaultRegion: defaultSourcingRegion() },
  automation: DEFAULT_AUTOMATION,
  stages: DEFAULT_STAGES,
  etsyTokens: null,
  pushPrefs: DEFAULT_PUSH_PREFS,
  catalogDraft: DEFAULT_CATALOG_DRAFT,
  manifestBackfill: { afterId: 0 },
  podProducts: DEFAULT_POD_PRODUCTS,
};

export async function getSetting<K extends keyof SettingMap>(db: DB, key: K): Promise<SettingMap[K]> {
  const [row] = await db.select().from(settings).where(eq(settings.key, key));
  if (key === "podProducts") return normalizePodProductSettings(row?.value) as SettingMap[K];
  if (key === "sourcing") {
    const value = row?.value as { defaultRegion?: string } | undefined;
    return { defaultRegion: defaultSourcingRegion(value?.defaultRegion) } as SettingMap[K];
  }
  if (!row) return DEFAULTS[key];
  const def = DEFAULTS[key];
  if (def && typeof def === "object" && !Array.isArray(def)) {
    return { ...def, ...(row.value as object) } as SettingMap[K];
  }
  return row.value as SettingMap[K];
}

export async function setSetting<K extends keyof SettingMap>(db: DB, key: K, value: SettingMap[K]) {
  await db
    .insert(settings)
    .values({ key, value: value as unknown as object, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value: value as unknown as object, updatedAt: new Date() } });
}
