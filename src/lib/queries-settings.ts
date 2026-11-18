import { count, desc } from "drizzle-orm";
import { getDb } from "@/db";
import { printifyEvents } from "@/db/schema";
import { config, hasEtsyCredentials, hasPrintifyCredentials, isDemoMode } from "./config";
import { printifyEventLog } from "./ops-copy";
import { registeredWebhookCount } from "./printify-webhooks";
import { connectionHealth } from "./health";
import { providerCreditSignal } from "./provider-errors";
import { effectivePublishMode } from "./publish-mode";
import { setupPresence } from "./setup-guide";
import { resolveRequestShop } from "./shops";
import { getSetting } from "./settings";
import { getLastRuns } from "./queries-runs";

export async function getConnectionsData() {
  const db = await getDb();
  const shop = await resolveRequestShop(db).catch(() => null);
  const [tokens, automation, stages, lastRuns, eventCount, recentEvents] = await Promise.all([
    getSetting(db, "etsyTokens"),
    getSetting(db, "automation"),
    getSetting(db, "stages"),
    getLastRuns(),
    db.select({ total: count() }).from(printifyEvents),
    db
      .select({
        id: printifyEvents.id,
        eventId: printifyEvents.eventId,
        topic: printifyEvents.topic,
        createdAt: printifyEvents.createdAt,
        verified: printifyEvents.verified,
      })
      .from(printifyEvents)
      .orderBy(desc(printifyEvents.id))
      .limit(8),
  ]);
  const etsyConnected = Boolean(tokens?.accessToken);
  const accessExpired = Boolean(tokens?.expiresAt && Date.now() > tokens.expiresAt);
  const publishMode = effectivePublishMode(automation.publishMode);
  const webhooksRegistered = registeredWebhookCount(lastRuns.find((stage) => stage.id === "maintenance")?.run?.summary);
  const designRun = lastRuns.find((stage) => stage.id === "design")?.run ?? null;
  const providerCredits = providerCreditSignal(designRun);
  return {
    checks: connectionHealth({
      etsyConnected,
      publishMode,
      accessExpired,
      etsyShopId: shop?.etsyShopId,
      webhooksRegistered,
      providerCredits,
      imageRun: designRun,
    }),
    webhooksRegistered,
    etsyConnected,
    canConnectEtsy: Boolean(config.etsy.apiKey),
    etsyKeysReady: hasEtsyCredentials(shop?.etsyShopId),
    printifyConfigured: hasPrintifyCredentials(),
    webhookSecretSet: Boolean(config.printify.webhookSecret),
    printifyEventCount: Number(eventCount[0]?.total ?? 0),
    printifyEvents: printifyEventLog(recentEvents),
    stages,
    lastRuns,
    killSwitch: automation.killSwitch,
    publishMode,
    envPublishMode: config.publishMode,
    demo: isDemoMode(shop?.etsyShopId),
    presence: setupPresence(),
  };
}

export async function getSettingsData() {
  const db = await getDb();
  const [automation, stages, pushPrefs, podProducts, connections] = await Promise.all([
    getSetting(db, "automation"),
    getSetting(db, "stages"),
    getSetting(db, "pushPrefs"),
    getSetting(db, "podProducts"),
    getConnectionsData(),
  ]);
  return { ...connections, automation, stages, pushPrefs, podProducts };
}
