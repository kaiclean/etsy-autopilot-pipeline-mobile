import { config, hasEtsyCredentials, hasGelatoCredentials, hasPrintifyCredentials, isDemoMode, resolvePrintifyPin, storageBackend, vapidConfigured } from "./config";
import { type ImageRunFact, type ProviderCreditSignal } from "./provider-errors";
import { effectivePublishMode, type PublishMode } from "./publish-mode";
import { POD_PRESETS, type PodPreset } from "./fees";
import { explicit, imageCheck, llmCheck, overlayImageRun } from "./health-providers";

export type HealthLevel = "green" | "yellow" | "red";

export type HealthCheck = {
  id: string;
  name: string;
  level: HealthLevel;
  label: string;
  detail: string;
  envVars: string[];
};

/** Hostname only, used to tell Neon from a generic Postgres URL. The connection string is never returned. */
function databaseHost(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function databaseCheck(): HealthCheck {
  const envVars = ["DATABASE_URL"];
  const url = config.databaseUrl;
  if (!url) {
    return {
      id: "database",
      name: "Neon DB",
      level: "yellow",
      label: "Local",
      detail: "Embedded PGlite. Set DATABASE_URL to use Neon Postgres.",
      envVars,
    };
  }
  const host = databaseHost(url);
  const neon = host.endsWith(".neon.tech");
  return {
    id: "database",
    name: "Neon DB",
    level: "green",
    label: "Connected",
    detail: neon ? "Neon Postgres is configured. The connection string is hidden." : "Postgres is configured via DATABASE_URL. The connection string is hidden.",
    envVars,
  };
}

function etsyCheck(etsyConnected: boolean, publishMode: PublishMode, accessExpired: boolean, shopId?: string | null): HealthCheck {
  const envVars = ["ETSY_API_KEY", "ETSY_SHARED_SECRET", "ETSY_SHOP_ID", "ETSY_REDIRECT_URI"];
  const shop = shopId?.trim() || config.etsy.shopId;
  if (etsyConnected && accessExpired) {
    return {
      id: "etsy",
      name: "Etsy OAuth",
      level: "yellow",
      label: "Refresh due",
      detail: shop
        ? `OAuth tokens are stored for shop ${shop}. The access token is past its expiry. The refresh token is used on the next shop read. Token values are hidden.`
        : "OAuth tokens are stored. The access token is past its expiry. The refresh token is used on the next shop read. Token values are hidden.",
      envVars,
    };
  }
  if (etsyConnected) {
    return {
      id: "etsy",
      name: "Etsy OAuth",
      level: "green",
      label: "Connected",
      detail: shop
        ? `OAuth tokens are stored for shop ${shop}. Token values are hidden. Dashboard publish choice is ${publishMode}.`
        : `OAuth tokens are stored. Token values are hidden. Dashboard publish choice is ${publishMode}.`,
      envVars,
    };
  }
  if (hasEtsyCredentials(shopId)) {
    return {
      id: "etsy",
      name: "Etsy OAuth",
      level: "yellow",
      label: "No tokens",
      detail: "App keys are set. OAuth tokens are missing. Connect the shop to authorize it.",
      envVars,
    };
  }
  return {
    id: "etsy",
    name: "Etsy OAuth",
    level: "red",
    label: "Missing",
    detail: "OAuth tokens are missing, and the Etsy app keys are not all set.",
    envVars,
  };
}

function printifyCheck(webhooksRegistered?: number | null): HealthCheck {
  const envVars = ["PRINTIFY_API_TOKEN", "PRINTIFY_SHOP_ID", "PRINTIFY_PRESETS_JSON", "PRINTIFY_PIN_PRESET", "PRINTIFY_BLUEPRINT_ID", "PRINTIFY_PRINT_PROVIDER_ID", "PRINTIFY_VARIANT_IDS", "PRINTIFY_WEBHOOK_SECRET"];
  const registered = webhooksRegistered == null ? " Webhooks: registration not checked." :
    webhooksRegistered > 0 ? ` Webhooks: ${webhooksRegistered} registered.` : " Webhooks: none registered.";
  let p: typeof config.printify;
  try {
    p = config.printify;
    if (p.pinConfigError) throw new Error("Invalid Printify pins");
  } catch {
    return {
      id: "printify",
      name: "Printify API",
      level: "red",
      label: "Invalid pins",
      detail: `Check PRINTIFY_PRESETS_JSON and the legacy pin variables. Invalid pins block creation.${registered}`,
      envVars,
    };
  }
  const presets = (Object.keys(POD_PRESETS) as PodPreset[])
    .map((preset) => `${POD_PRESETS[preset].label}: ${resolvePrintifyPin(preset) ? "pinned" : "missing"}`)
    .join("; ");
  const pins = `Preset pins — ${presets}.`;
  if (hasPrintifyCredentials()) {
    const allPinned = (Object.keys(POD_PRESETS) as PodPreset[]).every((preset) => resolvePrintifyPin(preset));
    return {
      id: "printify",
      name: "Printify API",
      level: allPinned ? "green" : "yellow",
      label: allPinned ? "Ready" : "Pins missing",
      detail: `API token and shop id are set. ${pins} Unpinned products are held; blanks are never auto-selected. ${webhookNote(p.webhookSecret)}${registered}`,
      envVars,
    };
  }
  if (p.token || p.shopId) {
    return {
      id: "printify",
      name: "Printify API",
      level: "yellow",
      label: "Incomplete",
      detail: `Set both PRINTIFY_API_TOKEN and PRINTIFY_SHOP_ID. The dry-run adapter stays on until then. ${pins} ${webhookNote(p.webhookSecret)}${registered}`,
      envVars,
    };
  }
  return {
    id: "printify",
    name: "Printify API",
    level: "yellow",
    label: "Dry-run",
    detail: `No Printify credentials. The dry-run adapter is active. ${pins} ${webhookNote(p.webhookSecret)}${registered}`,
    envVars,
  };
}

function webhookNote(secret: string | undefined) {
  return secret
    ? "PRINTIFY_WEBHOOK_SECRET is set. Callback is POST /api/webhooks/printify."
    : "PRINTIFY_WEBHOOK_SECRET is missing. Production rejects unsigned webhook deliveries.";
}

function gelatoCheck(): HealthCheck {
  const configured = hasGelatoCredentials();
  return {
    id: "gelato",
    name: "Gelato API",
    level: configured ? "green" : "yellow",
    label: configured ? "Configured" : "Skipped",
    detail: configured
      ? "API key is configured and hidden. Gelato writes remain dry-run only; costs are unverified."
      : "Optional supplier skipped because GELATO_API_KEY is unset. Gelato writes remain dry-run only.",
    envVars: ["GELATO_API_KEY"],
  };
}

function storageCheck(): HealthCheck {
  const envVars = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_ENDPOINT_URL_S3", "AWS_REGION", "S3_BUCKET", "S3_PUBLIC_BASE_URL", "BLOB_READ_WRITE_TOKEN"];
  const backend = storageBackend();
  if (backend === "s3") {
    return {
      id: "storage",
      name: "Image storage",
      level: "green",
      label: "S3",
      detail: "S3 credentials and a bucket are set. Keys and the bucket name are hidden. Public objects use S3_PUBLIC_BASE_URL when that is set, otherwise /api/media.",
      envVars,
    };
  }
  if (backend === "blob") {
    return {
      id: "storage",
      name: "Image storage",
      level: "green",
      label: "Blob",
      detail: "BLOB_READ_WRITE_TOKEN is set. The token is hidden. S3 is used instead when AWS credentials and a bucket are set.",
      envVars,
    };
  }
  return {
    id: "storage",
    name: "Image storage",
    level: "yellow",
    label: "Data URL",
    detail: "Generated images stay in the database until S3 or BLOB_READ_WRITE_TOKEN is set.",
    envVars,
  };
}

function pushCheck(): HealthCheck {
  const envVars = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"];
  if (vapidConfigured()) {
    return {
      id: "webpush",
      name: "Web Push",
      level: "green",
      label: "Ready",
      detail: "VAPID keys are set. Sales, approval, and failure events can be pushed. The keys are hidden.",
      envVars,
    };
  }
  return {
    id: "webpush",
    name: "Web Push",
    level: "yellow",
    label: "In-app",
    detail: "In-app alerts still work. Set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT (mailto:) for push when the PWA is closed.",
    envVars,
  };
}

function publishCheck(mode: PublishMode): HealthCheck {
  const host = config.publishMode;
  const envVars = ["PUBLISH_MODE"];
  if (mode === "live" && host === "live") {
    return {
      id: "publish",
      name: "PUBLISH_MODE",
      level: "red",
      label: "Live",
      detail:
        "Dashboard choice and host PUBLISH_MODE are both live, so Etsy and Printify write APIs can run. Return to dry-run from Connections or Settings. Digital listings stay drafts until a human verifies the file and activates that listing. POD is created in Printify only; publishing it to Etsy is a separate step and needs a recorded sample.",
      envVars,
    };
  }
  if (mode === "live") {
    return {
      id: "publish",
      name: "PUBLISH_MODE",
      level: "yellow",
      label: "Blocked",
      detail: `Dashboard choice is live, but host PUBLISH_MODE is ${host}, so write APIs stay off. Set PUBLISH_MODE=live on the host to honor that choice, or return to dry-run from Connections or Settings. Shop reads stay connected.`,
      envVars,
    };
  }
  return {
    id: "publish",
    name: "PUBLISH_MODE",
    level: "yellow",
    label: "Dry-run",
    detail: `Dashboard choice is dry-run, so live writes stay off. Host PUBLISH_MODE is ${host}. That variable does not publish by itself.`,
    envVars,
  };
}

function demoCheck(shopId?: string | null): HealthCheck {
  const flag = explicit("DEMO_MODE");
  const on = isDemoMode(shopId);
  if (on) {
    return {
      id: "demo",
      name: "DEMO_MODE",
      level: "yellow",
      label: "On",
      detail:
        flag === "true"
          ? "DEMO_MODE=true. Seeded demo rows are visible and are badged Demo."
          : "DEMO_MODE is unset, so demo stays on until Etsy keys exist. Seeded rows are visible and badged Demo.",
      envVars: ["DEMO_MODE"],
    };
  }
  return {
    id: "demo",
    name: "DEMO_MODE",
    level: "green",
    label: "Off",
    detail: flag === "false" ? "DEMO_MODE=false. Seeded demo rows are hidden." : "Etsy keys are set and DEMO_MODE is unset, so seeded demo rows are hidden.",
    envVars: ["DEMO_MODE"],
  };
}

function authCheck(): HealthCheck {
  const envVars = ["DASHBOARD_PASSWORD", "AUTH_SECRET"];
  if (!config.usingDevPassword) {
    return {
      id: "auth",
      name: "Dashboard auth",
      level: "green",
      label: "Password",
      detail: "Password sign-in is configured. The password is hidden.",
      envVars,
    };
  }
  const production = process.env.NODE_ENV === "production";
  return {
    id: "auth",
    name: "Dashboard auth",
    level: production ? "red" : "yellow",
    label: production ? "Missing" : "Dev password",
    detail: production
      ? "Set DASHBOARD_PASSWORD and AUTH_SECRET. Sign-in stays disabled until both exist."
      : "DASHBOARD_PASSWORD is unset, so local dev uses the built-in fallback. Set it before production.",
    envVars,
  };
}

export function connectionHealth(input: {
  etsyConnected: boolean;
  publishMode?: PublishMode;
  accessExpired?: boolean;
  etsyShopId?: string | null;
  webhooksRegistered?: number | null;
  /** Latest design run. 402/credit errors turn the image check red or amber. */
  providerCredits?: ProviderCreditSignal;
  /** Latest design run. A 401, 404, or model error replaces the image check's Ready. */
  imageRun?: ImageRunFact | null;
}): HealthCheck[] {
  const publishMode = effectivePublishMode(input.publishMode);
  const providerCredits = input.providerCredits ?? "ok";
  return [
    databaseCheck(),
    etsyCheck(input.etsyConnected, publishMode, input.accessExpired === true, input.etsyShopId),
    printifyCheck(input.webhooksRegistered),
    gelatoCheck(),
    storageCheck(),
    pushCheck(),
    llmCheck("ok"),
    overlayImageRun(imageCheck(providerCredits), input.imageRun),
    publishCheck(publishMode),
    demoCheck(input.etsyShopId),
    authCheck(),
  ];
}

export function healthTone(level: HealthLevel) {
  if (level === "green") return { dot: "bg-success", pill: "bg-success/15 text-success", label: "Healthy" };
  if (level === "yellow") return { dot: "bg-warning", pill: "bg-warning/15 text-warning", label: "Attention" };
  return { dot: "bg-destructive", pill: "bg-destructive/15 text-destructive", label: "Action needed" };
}
