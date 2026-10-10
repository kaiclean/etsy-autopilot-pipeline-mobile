import { config, hasEtsyCredentials, hasPrintifyCredentials, isDemoMode, storageBackend, vapidConfigured } from "./config";
import { imageEndpointConfigurationError, imageProviderStatusLabel, lastImageProviderError, type ImageRunFact, type ProviderCreditSignal } from "./provider-errors";
import { effectivePublishMode, type PublishMode } from "./publish-mode";

export type HealthLevel = "green" | "yellow" | "red";

export type HealthCheck = {
  id: string;
  name: string;
  level: HealthLevel;
  label: string;
  detail: string;
  envVars: string[];
};

function explicit(name: string) {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

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
  const envVars = ["PRINTIFY_API_TOKEN", "PRINTIFY_SHOP_ID", "PRINTIFY_BLUEPRINT_ID", "PRINTIFY_PRINT_PROVIDER_ID", "PRINTIFY_VARIANT_IDS", "PRINTIFY_WEBHOOK_SECRET"];
  const p = config.printify;
  const registered = webhooksRegistered == null ? "" : ` Webhooks: ${webhooksRegistered} registered.`;
  if (hasPrintifyCredentials()) {
    const blueprint = p.blueprintId ? `Blueprint ${p.blueprintId} is set.` : "Blueprint is chosen from the Printify catalog when a listing publishes.";
    return {
      id: "printify",
      name: "Printify API",
      level: "green",
      label: "Ready",
      detail: `API token and shop id are set. ${blueprint} The token is hidden. ${webhookNote(p.webhookSecret)}${registered}`,
      envVars,
    };
  }
  if (p.token || p.shopId) {
    return {
      id: "printify",
      name: "Printify API",
      level: "yellow",
      label: "Incomplete",
      detail: `Set both PRINTIFY_API_TOKEN and PRINTIFY_SHOP_ID. The dry-run adapter stays on until then. ${webhookNote(p.webhookSecret)}${registered}`,
      envVars,
    };
  }
  return {
    id: "printify",
    name: "Printify API",
    level: "yellow",
    label: "Dry-run",
    detail: `No Printify credentials. The dry-run adapter is active. ${webhookNote(p.webhookSecret)}${registered}`,
    envVars,
  };
}

function webhookNote(secret: string | undefined) {
  return secret
    ? "PRINTIFY_WEBHOOK_SECRET is set. Callback is POST /api/webhooks/printify."
    : "PRINTIFY_WEBHOOK_SECRET is missing. Production rejects unsigned webhook deliveries.";
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

function overlayCredits(check: HealthCheck, signal: ProviderCreditSignal, which: "images" | "llm"): HealthCheck {
  if (signal === "ok" || check.label === "Key missing") return check;
  const failed = signal === "failed";
  const who = which === "images" ? "Image generation" : "The listing writer";
  return {
    ...check,
    level: failed ? "red" : "yellow",
    label: failed ? "Out of credits" : "Low credits",
    detail: `${who} returned 402 Insufficient credits on the latest design run. Keys are still set. Token values are hidden.`,
  };
}

function llmCheck(signal: ProviderCreditSignal): HealthCheck {
  return overlayCredits(llmProviderCheck(), signal, "llm");
}

function imageCheck(signal: ProviderCreditSignal): HealthCheck {
  return overlayCredits(imageProviderCheck(), signal, "images");
}

function llmProviderCheck(): HealthCheck {
  const envVars = [
    "LLM_PROVIDER",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_MODEL",
    "OLLAMA_API_KEY",
    "OLLAMA_MODEL",
    "OMNIROUTE_API_KEY",
    "OMNIROUTE_BASE_URL",
    "OMNIROUTE_MODEL",
  ];
  const requested = explicit("LLM_PROVIDER");
  if (requested === "openai" && !config.openaiKey) {
    return {
      id: "llm",
      name: "LLM provider",
      level: "red",
      label: "Key missing",
      detail: "LLM_PROVIDER=openai but OPENAI_API_KEY is unset. The template writer is still in use.",
      envVars,
    };
  }
  if (requested === "ollama" && !config.ollama.apiKey) {
    return {
      id: "llm",
      name: "LLM provider",
      level: "red",
      label: "Key missing",
      detail: "LLM_PROVIDER=ollama but OLLAMA_API_KEY is unset. The template writer is still in use.",
      envVars,
    };
  }
  if (requested === "omniroute" && !config.omniroute.apiKey) {
    return {
      id: "llm",
      name: "LLM provider",
      level: "red",
      label: "Key missing",
      detail: "LLM_PROVIDER=omniroute but OMNIROUTE_API_KEY is unset. The template writer is still in use.",
      envVars,
    };
  }
  if (config.llmProvider === "openai") {
    return {
      id: "llm",
      name: "LLM provider",
      level: "green",
      label: "Ready",
      detail: `OpenAI-compatible · ${config.openaiModel} · ${config.openaiBaseUrl}`,
      envVars,
    };
  }
  if (config.llmProvider === "ollama") {
    return {
      id: "llm",
      name: "LLM provider",
      level: "green",
      label: "Ready",
      detail: `Ollama Cloud · ${config.ollama.model} · ${config.ollama.baseUrl}`,
      envVars,
    };
  }
  if (config.llmProvider === "omniroute") {
    const base = config.omniroute.baseUrl;
    const model = config.omniroute.model;
    const ready = Boolean(base && model);
    return {
      id: "llm",
      name: "LLM provider",
      level: ready ? "green" : "yellow",
      label: ready ? "Ready" : "Incomplete",
      detail: `OmniRoute · ${model ?? "OMNIROUTE_MODEL unset"} · ${base ?? "OMNIROUTE_BASE_URL unset"}`,
      envVars,
    };
  }
  return {
    id: "llm",
    name: "LLM provider",
    level: "yellow",
    label: "Mock",
    detail: "Deterministic template writer. Set LLM_PROVIDER to openai, ollama, or omniroute.",
    envVars,
  };
}

function imageProviderCheck(): HealthCheck {
  const envVars = [
    "IMAGE_PROVIDER",
    "IMAGE_API_KEY",
    "IMAGE_BASE_URL",
    "IMAGE_MODEL",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_IMAGE_MODEL",
    "OMNIROUTE_API_KEY",
    "OMNIROUTE_BASE_URL",
    "OMNIROUTE_IMAGE_MODEL",
    "HIGGSFIELD_API_KEY",
    "HIGGSFIELD_API_SECRET",
    "REPLICATE_API_TOKEN",
  ];
  const provider = config.imageProvider;
  if (provider === "openai") {
    if (!config.imageApiKey) {
      return {
        id: "images",
        name: "Image provider",
        level: "red",
        label: "Key missing",
        detail: "IMAGE_PROVIDER=openai but IMAGE_API_KEY and OPENAI_API_KEY are unset.",
        envVars,
      };
    }
    const configurationError = imageEndpointConfigurationError(config.imageBaseUrl);
    return {
      id: "images",
      name: "Image provider",
      level: configurationError ? "red" : "green",
      label: configurationError ? "Invalid endpoint" : "Ready",
      detail: configurationError ?? `OpenAI-compatible · ${config.imageModel} · ${config.imageBaseUrl}`,
      envVars,
    };
  }
  if (provider === "omniroute") {
    if (!config.omniroute.apiKey) {
      return {
        id: "images",
        name: "Image provider",
        level: "red",
        label: "Key missing",
        detail: "IMAGE_PROVIDER=omniroute but OMNIROUTE_API_KEY is unset.",
        envVars,
      };
    }
    const base = config.omniroute.baseUrl;
    const model = config.omniroute.imageModel;
    const configurationError = base ? imageEndpointConfigurationError(base) : null;
    const ready = Boolean(base && model);
    return {
      id: "images",
      name: "Image provider",
      level: configurationError ? "red" : ready ? "green" : "yellow",
      label: configurationError ? "Invalid endpoint" : ready ? "Ready" : "Incomplete",
      detail: configurationError ?? `OmniRoute · ${model ?? "OMNIROUTE_IMAGE_MODEL unset"} · ${base ?? "OMNIROUTE_BASE_URL unset"}`,
      envVars,
    };
  }
  if (provider === "higgsfield") {
    if (!config.higgsfield.apiKey) {
      return {
        id: "images",
        name: "Image provider",
        level: "red",
        label: "Key missing",
        detail: "IMAGE_PROVIDER=higgsfield but HIGGSFIELD_API_KEY is unset.",
        envVars,
      };
    }
    return {
      id: "images",
      name: "Image provider",
      level: "green",
      label: "Ready",
      detail: `Higgsfield · ${config.higgsfield.baseUrl}. The API key is hidden.`,
      envVars,
    };
  }
  if (provider === "replicate") {
    if (!config.replicateToken) {
      return {
        id: "images",
        name: "Image provider",
        level: "red",
        label: "Key missing",
        detail: "IMAGE_PROVIDER=replicate but REPLICATE_API_TOKEN is unset.",
        envVars,
      };
    }
    return {
      id: "images",
      name: "Image provider",
      level: "green",
      label: "Ready",
      detail: "Replicate token is set. The token is hidden.",
      envVars,
    };
  }
  return {
    id: "images",
    name: "Image provider",
    level: "yellow",
    label: "Mock",
    detail: "Mock placeholder art. Set IMAGE_PROVIDER to higgsfield, openai, replicate, or omniroute. IMAGE_BASE_URL falls back to OPENAI_BASE_URL.",
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

function overlayImageRun(check: HealthCheck, run: ImageRunFact | null | undefined): HealthCheck {
  const error = lastImageProviderError(run);
  if (!error || check.label === "Key missing") return check;
  return {
    ...check,
    level: run?.status === "warning" ? "yellow" : "red",
    label: imageProviderStatusLabel(error),
    detail: error,
  };
}

/** Status for the command center. Reports env var names and modes only, never secret values. */
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
