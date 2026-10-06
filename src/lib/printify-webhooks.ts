import { PrintifyLiveClient, type PrintifyWebhookRef } from "@/adapters/printify/client";
import { config, isDemoMode } from "@/lib/config";
import { PRINTIFY_WEBHOOK_TOPICS } from "@/lib/ops-copy";

const PRODUCTION_FALLBACK = "https://etsy-autopilot-production-8b9f.up.railway.app";

export type PrintifyWebhookClient = {
  listWebhooks(): Promise<PrintifyWebhookRef[]>;
  createWebhook(input: { topic: string; url: string; secret: string }): Promise<unknown>;
};

export type WebhookEnsureResult = {
  existing: number;
  created: number;
  skipped: number;
  reason: string | null;
};

function present(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function absoluteOrigin(value: string | undefined) {
  const trimmed = present(value);
  if (!trimmed) return undefined;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${path === "/" ? "" : path}`;
  } catch {
    return withScheme.replace(/\/+$/, "");
  }
}

/**
 * Public callback for Printify. Prefers APP_URL, then PUBLIC_BASE_URL, then
 * RAILWAY_PUBLIC_DOMAIN, then the production Railway host. Userinfo in the
 * base URL is dropped so it is never sent to Printify.
 */
export function printifyWebhookCallbackUrl(env?: { APP_URL?: string; PUBLIC_BASE_URL?: string; RAILWAY_PUBLIC_DOMAIN?: string }) {
  const source = env ?? {
    APP_URL: process.env.APP_URL,
    PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
    RAILWAY_PUBLIC_DOMAIN: process.env.RAILWAY_PUBLIC_DOMAIN,
  };
  const fromApp = absoluteOrigin(source.APP_URL) ?? absoluteOrigin(source.PUBLIC_BASE_URL);
  if (fromApp) return `${fromApp}/api/webhooks/printify`;
  const domain = present(source.RAILWAY_PUBLIC_DOMAIN)?.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  if (domain) return `https://${domain}/api/webhooks/printify`;
  return `${PRODUCTION_FALLBACK}/api/webhooks/printify`;
}

function urlsMatch(left: string, right: string) {
  return left.trim().replace(/\/+$/, "") === right.trim().replace(/\/+$/, "");
}

function skippedAll(reason: string): WebhookEnsureResult {
  return { existing: 0, created: 0, skipped: PRINTIFY_WEBHOOK_TOPICS.length, reason };
}

/** Dry-run, demo, and missing Printify env all skip before any API call. */
export function webhookSkipReason() {
  if (isDemoMode()) return "demo mode";
  if (config.publishMode !== "live") return "dry-run";
  if (!config.printify.token) return "missing PRINTIFY_API_TOKEN";
  if (!config.printify.shopId) return "missing PRINTIFY_SHOP_ID";
  if (!config.printify.webhookSecret) return "missing PRINTIFY_WEBHOOK_SECRET";
  return null;
}

function safeReason(error: unknown) {
  let message = error instanceof Error ? error.message : "Printify webhook request failed";
  const secret = config.printify.webhookSecret;
  const token = config.printify.token;
  if (secret) message = message.split(secret).join("[redacted]");
  if (token) message = message.split(token).join("[redacted]");
  return message.slice(0, 180);
}

function liveWebhookClient(): PrintifyWebhookClient {
  const live = new PrintifyLiveClient();
  return {
    listWebhooks: () => live.listWebhooks(),
    createWebhook: (input) => live.createWebhook(input),
  };
}

/**
 * Register each needed topic once against our callback.
 * A topic already pointing at that URL is left alone. The secret is sent to
 * Printify and is never included in the returned counts.
 */
export async function ensurePrintifyWebhooks(opts: { client?: PrintifyWebhookClient } = {}): Promise<WebhookEnsureResult> {
  const reason = webhookSkipReason();
  if (reason) return skippedAll(reason);
  const secret = config.printify.webhookSecret;
  if (!secret) return skippedAll("missing PRINTIFY_WEBHOOK_SECRET");
  const url = printifyWebhookCallbackUrl();
  const client = opts.client ?? liveWebhookClient();
  let listed: PrintifyWebhookRef[];
  try {
    listed = await client.listWebhooks();
  } catch (error) {
    return skippedAll(safeReason(error));
  }
  const ours = new Set(listed.filter((row) => urlsMatch(row.url, url)).map((row) => row.topic));
  let existing = 0;
  let created = 0;
  let failed = 0;
  let failure: string | null = null;
  for (const topic of PRINTIFY_WEBHOOK_TOPICS) {
    if (ours.has(topic)) {
      existing += 1;
      continue;
    }
    try {
      await client.createWebhook({ topic, url, secret });
      created += 1;
    } catch (error) {
      failed += 1;
      failure ??= safeReason(error);
    }
  }
  return { existing, created, skipped: failed, reason: failure };
}

type WebhookCounts = { existing?: unknown; created?: unknown; reason?: unknown };

/** Count from the last maintenance summary. A skipped run does not invent a zero. */
export function registeredWebhookCount(summary: string | null | undefined): number | null {
  if (!summary) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(summary);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const webhooks = (parsed as { webhooks?: WebhookCounts }).webhooks;
  if (!webhooks || typeof webhooks !== "object") return null;
  const existing = Number(webhooks.existing);
  const created = Number(webhooks.created);
  if (!Number.isFinite(existing) || !Number.isFinite(created)) return null;
  const total = existing + created;
  if (typeof webhooks.reason === "string" && webhooks.reason && total === 0) return null;
  return total;
}
