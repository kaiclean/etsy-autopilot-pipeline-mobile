import { config, hasEtsyCredentials, hasPrintifyCredentials, isDemoMode } from "./config";

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

function etsyCheck(etsyConnected: boolean): HealthCheck {
  const envVars = ["ETSY_API_KEY", "ETSY_SHARED_SECRET", "ETSY_SHOP_ID", "ETSY_REDIRECT_URI"];
  const shop = config.etsy.shopId;
  if (etsyConnected) {
    return {
      id: "etsy",
      name: "Etsy OAuth",
      level: "green",
      label: "Connected",
      detail: shop
        ? `OAuth tokens are stored for shop ${shop}. Token values are hidden. Publish mode is ${config.publishMode}.`
        : `OAuth tokens are stored. Token values are hidden. Publish mode is ${config.publishMode}.`,
      envVars,
    };
  }
  if (hasEtsyCredentials()) {
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

function printifyCheck(): HealthCheck {
  const envVars = ["PRINTIFY_API_TOKEN", "PRINTIFY_SHOP_ID", "PRINTIFY_BLUEPRINT_ID", "PRINTIFY_PRINT_PROVIDER_ID", "PRINTIFY_VARIANT_IDS"];
  const p = config.printify;
  if (hasPrintifyCredentials()) {
    const blueprint = p.blueprintId ? `Blueprint ${p.blueprintId} is set.` : "Blueprint is chosen from the Printify catalog when a listing publishes.";
    return {
      id: "printify",
      name: "Printify API",
      level: "green",
      label: "Ready",
      detail: `API token and shop id are set. ${blueprint} The token is hidden.`,
      envVars,
    };
  }
  if (p.token || p.shopId) {
    return {
      id: "printify",
      name: "Printify API",
      level: "yellow",
      label: "Incomplete",
      detail: "Set both PRINTIFY_API_TOKEN and PRINTIFY_SHOP_ID. The dry-run adapter stays on until then.",
      envVars,
    };
  }
  return {
    id: "printify",
    name: "Printify API",
    level: "yellow",
    label: "Dry-run",
    detail: "No Printify credentials. The dry-run adapter is active.",
    envVars,
  };
}

function llmCheck(): HealthCheck {
  const envVars = ["LLM_PROVIDER", "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"];
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
  return {
    id: "llm",
    name: "LLM provider",
    level: "yellow",
    label: "Mock",
    detail: "Deterministic template writer. Set LLM_PROVIDER=openai and OPENAI_API_KEY for generated copy.",
    envVars,
  };
}

function imageCheck(): HealthCheck {
  const envVars = [
    "IMAGE_PROVIDER",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_IMAGE_MODEL",
    "HIGGSFIELD_API_KEY",
    "HIGGSFIELD_API_SECRET",
    "REPLICATE_API_TOKEN",
  ];
  const provider = config.imageProvider;
  if (provider === "openai") {
    if (!config.openaiKey) {
      return {
        id: "images",
        name: "Image provider",
        level: "red",
        label: "Key missing",
        detail: "IMAGE_PROVIDER=openai but OPENAI_API_KEY is unset.",
        envVars,
      };
    }
    return {
      id: "images",
      name: "Image provider",
      level: "green",
      label: "Ready",
      detail: `OpenAI-compatible · ${config.openaiImageModel} · ${config.openaiBaseUrl}`,
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
    detail: "Mock placeholder art. Set IMAGE_PROVIDER to higgsfield, openai, or replicate.",
    envVars,
  };
}

function publishCheck(): HealthCheck {
  const live = config.publishMode === "live";
  return {
    id: "publish",
    name: "PUBLISH_MODE",
    level: live ? "red" : "yellow",
    label: live ? "Live" : "Dry-run",
    detail: live
      ? "PUBLISH_MODE=live. Etsy and Printify write APIs can run. Keep this at dry-run unless you mean to publish."
      : "Locked to dry-run. Live Etsy and Printify publishes stay off.",
    envVars: ["PUBLISH_MODE"],
  };
}

function demoCheck(): HealthCheck {
  const flag = explicit("DEMO_MODE");
  const on = isDemoMode();
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

/** Status for the command center. Reports env var names and modes only, never secret values. */
export function connectionHealth(input: { etsyConnected: boolean }): HealthCheck[] {
  return [
    databaseCheck(),
    etsyCheck(input.etsyConnected),
    printifyCheck(),
    llmCheck(),
    imageCheck(),
    publishCheck(),
    demoCheck(),
    authCheck(),
  ];
}

export function healthTone(level: HealthLevel) {
  if (level === "green") return { dot: "bg-success", pill: "bg-success/15 text-success", label: "Healthy" };
  if (level === "yellow") return { dot: "bg-warning", pill: "bg-warning/15 text-warning", label: "Attention" };
  return { dot: "bg-destructive", pill: "bg-destructive/15 text-destructive", label: "Action needed" };
}
