import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import { settings } from "@/db/schema";
import type { StageName } from "@/db/schema";
import { MARGIN_TARGETS } from "@/lib/fees";
import { DEFAULT_PUSH_PREFS, type PushPrefs } from "@/lib/push-prefs";

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

export type EtsyTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  userId?: string;
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
  produce: { paused: false, cron: "45 6 * * *" },
  publish: { paused: false, cron: "0 7 * * *" },
  orders: { paused: false, cron: "0 8 * * *" },
  analytics: { paused: false, cron: "0 3 * * *" },
};

type SettingMap = {
  automation: AutomationSettings;
  stages: StageSettings;
  etsyTokens: EtsyTokens | null;
  pushPrefs: PushPrefs;
};

const DEFAULTS: SettingMap = {
  automation: DEFAULT_AUTOMATION,
  stages: DEFAULT_STAGES,
  etsyTokens: null,
  pushPrefs: DEFAULT_PUSH_PREFS,
};

export async function getSetting<K extends keyof SettingMap>(db: DB, key: K): Promise<SettingMap[K]> {
  const [row] = await db.select().from(settings).where(eq(settings.key, key));
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
