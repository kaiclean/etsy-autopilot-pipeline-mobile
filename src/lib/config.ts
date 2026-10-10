import type { ProviderCreditSignal } from "./provider-errors";

const env = (k: string) => {
  const v = process.env[k];
  return v && v.trim() !== "" ? v.trim() : undefined;
};

export const config = {
  get databaseUrl() {
    return env("DATABASE_URL");
  },
  get etsy() {
    return {
      apiKey: env("ETSY_API_KEY"),
      sharedSecret: env("ETSY_SHARED_SECRET"),
      shopId: env("ETSY_SHOP_ID"),
      redirectUri: env("ETSY_REDIRECT_URI"),
      taxonomyDigital: Number(env("ETSY_TAXONOMY_ID_DIGITAL") ?? 2078),
      taxonomyPoster: Number(env("ETSY_TAXONOMY_ID_POSTER") ?? 2078),
    };
  },
  get printify() {
    return {
      token: env("PRINTIFY_API_TOKEN"),
      shopId: env("PRINTIFY_SHOP_ID"),
      blueprintId: Number(env("PRINTIFY_BLUEPRINT_ID") ?? 0) || undefined,
      printProviderId: Number(env("PRINTIFY_PRINT_PROVIDER_ID") ?? 0) || undefined,
      variantIds: (env("PRINTIFY_VARIANT_IDS") ?? "")
        .split(",")
        .map((s) => Number(s.trim()))
        .filter(Boolean),
      webhookSecret: env("PRINTIFY_WEBHOOK_SECRET"),
    };
  },
  get vapid() {
    return {
      publicKey: env("VAPID_PUBLIC_KEY"),
      privateKey: env("VAPID_PRIVATE_KEY"),
      subject: env("VAPID_SUBJECT"),
    };
  },
  /** S3-compatible object storage (Railway buckets, AWS, R2, MinIO). Blob is the fallback. */
  get storage() {
    const force = env("S3_FORCE_PATH_STYLE");
    return {
      accessKeyId: env("AWS_ACCESS_KEY_ID"),
      secretAccessKey: env("AWS_SECRET_ACCESS_KEY"),
      endpoint: env("AWS_ENDPOINT_URL_S3") ?? env("AWS_ENDPOINT_URL"),
      region: env("AWS_REGION") ?? env("AWS_DEFAULT_REGION") ?? "auto",
      bucket: env("S3_BUCKET") ?? env("AWS_S3_BUCKET_NAME") ?? env("AWS_BUCKET_NAME"),
      publicBaseUrl: env("S3_PUBLIC_BASE_URL")?.replace(/\/$/, ""),
      /** signed = store a 7-day presigned URL. Default is a stable /api/media URL or S3_PUBLIC_BASE_URL. */
      urlMode: env("S3_URL_MODE") === "signed" ? ("signed" as const) : ("stable" as const),
      forcePathStyle: force !== "false",
      blobToken: env("BLOB_READ_WRITE_TOKEN"),
    };
  },
  get higgsfield() {
    return {
      apiKey: env("HIGGSFIELD_API_KEY"),
      apiSecret: env("HIGGSFIELD_API_SECRET"),
      baseUrl: env("HIGGSFIELD_API_BASE") ?? "https://platform.higgsfield.ai",
    };
  },
  get openaiKey() {
    return env("OPENAI_API_KEY");
  },
  /** OpenAI-compatible base. OpenRouter: https://openrouter.ai/api/v1 */
  get openaiBaseUrl() {
    return (env("OPENAI_BASE_URL") ?? "https://api.openai.com/v1").replace(/\/$/, "");
  },
  get openaiModel() {
    return env("OPENAI_MODEL") ?? "gpt-4.1-mini";
  },
  get openaiImageModel() {
    return env("OPENAI_IMAGE_MODEL") ?? "gpt-image-1";
  },
  /** Image calls. Each value falls back to the matching OPENAI_* setting. */
  get imageApiKey() {
    return env("IMAGE_API_KEY") ?? env("OPENAI_API_KEY");
  },
  get imageBaseUrl() {
    return (env("IMAGE_BASE_URL") ?? env("OPENAI_BASE_URL") ?? "https://api.openai.com/v1").replace(/\/$/, "");
  },
  get imageModel() {
    return env("IMAGE_MODEL") ?? env("OPENAI_IMAGE_MODEL") ?? "gpt-image-1";
  },
  /** Ollama Cloud chat. There is no image endpoint on this host. */
  get ollama() {
    return {
      apiKey: env("OLLAMA_API_KEY"),
      baseUrl: "https://ollama.com/v1",
      model: env("OLLAMA_MODEL") ?? "gemma4:31b",
    };
  },
  get omniroute() {
    const base = env("OMNIROUTE_BASE_URL");
    return {
      apiKey: env("OMNIROUTE_API_KEY"),
      baseUrl: base ? base.replace(/\/$/, "") : undefined,
      model: env("OMNIROUTE_MODEL"),
      imageModel: env("OMNIROUTE_IMAGE_MODEL"),
    };
  },
  get replicateToken() {
    return env("REPLICATE_API_TOKEN");
  },
  get imageProvider(): "mock" | "higgsfield" | "openai" | "replicate" | "omniroute" {
    const p = env("IMAGE_PROVIDER");
    if (p === "higgsfield" || p === "openai" || p === "replicate" || p === "omniroute") return p;
    return "mock";
  },
  get llmProvider(): "mock" | "openai" | "ollama" | "omniroute" {
    const p = env("LLM_PROVIDER");
    if (p === "openai" && env("OPENAI_API_KEY")) return "openai";
    if (p === "ollama" && env("OLLAMA_API_KEY")) return "ollama";
    if (p === "omniroute" && env("OMNIROUTE_API_KEY")) return "omniroute";
    return "mock";
  },
  get authSecret() {
    return env("AUTH_SECRET") ?? (process.env.NODE_ENV === "production" ? undefined : "dev-only-insecure-secret");
  },
  get dashboardPassword() {
    return env("DASHBOARD_PASSWORD") ?? (process.env.NODE_ENV === "production" ? undefined : "autopilot");
  },
  get usingDevPassword() {
    return !env("DASHBOARD_PASSWORD");
  },
  get cronSecret() {
    return env("CRON_SECRET");
  },
  get googleTrendsEnabled() {
    return env("RESEARCH_GOOGLE_TRENDS") !== "false";
  },
  /** Live publishing needs explicit opt-in on top of credentials. */
  get publishMode(): "dry-run" | "live" {
    return env("PUBLISH_MODE") === "live" ? "live" : "dry-run";
  },
};

/** Public origin used for media URLs and the Printify callback. */
export function publicAppUrl() {
  const raw = env("APP_URL") ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:4317");
  return raw.replace(/\/$/, "");
}

export function printifyWebhookUrl() {
  return `${publicAppUrl()}/api/webhooks/printify`;
}

/** All three VAPID values, and a mailto: or https: subject, are required before any push is sent. */
export function vapidConfigured() {
  const v = config.vapid;
  if (!v.publicKey || !v.privateKey || !v.subject) return false;
  return v.subject.startsWith("mailto:") || v.subject.startsWith("https://");
}

export function storageBackend(): "s3" | "blob" | "none" {
  const s = config.storage;
  if (s.accessKeyId && s.secretAccessKey && s.endpoint && s.bucket) return "s3";
  if (s.blobToken) return "blob";
  return "none";
}

export function hasEtsyCredentials(shopId?: string | null) {
  const e = config.etsy;
  return Boolean(e.apiKey && e.sharedSecret && (shopId?.trim() || e.shopId));
}

export function hasPrintifyCredentials() {
  const p = config.printify;
  return Boolean(p.token && p.shopId);
}

/** Demo mode = seeded demo rows visible + mock adapters. Switches off once Etsy creds exist. */
export function isDemoMode(shopId?: string | null) {
  if (env("DEMO_MODE") === "true") return true;
  if (env("DEMO_MODE") === "false") return false;
  return !hasEtsyCredentials(shopId);
}

export type IntegrationStatus = {
  id: string;
  name: string;
  status: "connected" | "configured" | "mock" | "missing";
  detail: string;
  envVars: string[];
};

function withCreditStatus(row: IntegrationStatus, signal: ProviderCreditSignal | undefined): IntegrationStatus {
  if (!signal || signal === "ok" || row.status === "missing") return row;
  if (signal === "failed") {
    return {
      ...row,
      status: "missing",
      detail: `${row.detail} Latest design run: image provider returned 402 Insufficient credits.`,
    };
  }
  return {
    ...row,
    detail: `${row.detail} Latest design run recorded 402 Insufficient credits.`,
  };
}

export function integrationStatus(etsyConnected: boolean, opts?: { providerCredits?: ProviderCreditSignal }): IntegrationStatus[] {
  const e = config.etsy;
  const p = config.printify;
  const h = config.higgsfield;
  const storage = storageBackend();
  const pushOn = vapidConfigured();
  return [
    {
      id: "database",
      name: "Database",
      status: config.databaseUrl ? "connected" : "mock",
      detail: config.databaseUrl ? "Postgres (Neon) via DATABASE_URL" : "Embedded PGlite (local file). Set DATABASE_URL for Neon.",
      envVars: ["DATABASE_URL"],
    },
    {
      id: "etsy",
      name: "Etsy Open API v3",
      status: hasEtsyCredentials() ? (etsyConnected ? "connected" : "configured") : "mock",
      detail: hasEtsyCredentials()
        ? etsyConnected
          ? `Shop ${e.shopId} authorized · publish mode: ${config.publishMode}`
          : "Keys present. Connect via OAuth to authorize the shop."
        : "Dry-run adapter. Add keys to go live.",
      envVars: ["ETSY_API_KEY", "ETSY_SHARED_SECRET", "ETSY_SHOP_ID", "ETSY_REDIRECT_URI"],
    },
    {
      id: "printify",
      name: "Printify",
      status: hasPrintifyCredentials() ? "configured" : "mock",
      detail: `${
        hasPrintifyCredentials()
          ? `Shop ${p.shopId}${p.blueprintId ? ` · blueprint ${p.blueprintId}` : " · blueprint chosen from the Printify catalog when a listing publishes"}`
          : "Dry-run adapter."
      } Webhook POST ${printifyWebhookUrl()}.${p.webhookSecret ? " Signatures are checked with PRINTIFY_WEBHOOK_SECRET." : " Set PRINTIFY_WEBHOOK_SECRET so production deliveries are verified."}`,
      envVars: ["PRINTIFY_API_TOKEN", "PRINTIFY_SHOP_ID", "PRINTIFY_BLUEPRINT_ID", "PRINTIFY_WEBHOOK_SECRET"],
    },
    {
      id: "storage",
      name: "Image storage",
      status: storage === "none" ? "mock" : "configured",
      detail:
        storage === "s3"
          ? `S3-compatible bucket ${config.storage.bucket}${config.storage.publicBaseUrl ? ` · public ${config.storage.publicBaseUrl}` : config.storage.urlMode === "signed" ? " · 7-day signed URLs" : " · served at /api/media"}`
          : storage === "blob"
            ? "Vercel Blob. S3 is used instead when AWS credentials and a bucket are set."
            : "Data URLs stay in the database until S3 (preferred) or BLOB_READ_WRITE_TOKEN is set.",
      envVars: [
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_ENDPOINT_URL_S3",
        "AWS_REGION",
        "S3_BUCKET",
        "S3_PUBLIC_BASE_URL",
        "BLOB_READ_WRITE_TOKEN",
      ],
    },
    {
      id: "webpush",
      name: "Web Push",
      status: pushOn ? "configured" : "mock",
      detail: pushOn
        ? "VAPID is set. Sales, approval, and failure events are pushed to subscribed browsers."
        : "In-app alerts still work. Set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT (mailto:) for push when the PWA is closed. npm run vapid:generate",
      envVars: ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"],
    },
    withCreditStatus(
      {
        id: "images",
        name: "Image generation",
        status: config.imageProvider === "mock" ? "mock" : "configured",
        detail:
          config.imageProvider === "mock"
            ? "Mock placeholder art. Set IMAGE_PROVIDER=higgsfield|openai|replicate|omniroute."
            : config.imageProvider === "openai"
              ? `OpenAI-compatible · ${config.imageModel} · ${config.imageBaseUrl}`
              : config.imageProvider === "omniroute"
                ? `OmniRoute · ${config.omniroute.imageModel ?? "OMNIROUTE_IMAGE_MODEL unset"} · ${config.omniroute.baseUrl ?? "OMNIROUTE_BASE_URL unset"}`
                : `Provider: ${config.imageProvider}${config.imageProvider === "higgsfield" && !h.apiKey ? " (missing key)" : ""}`,
        envVars: [
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
        ],
      },
      opts?.providerCredits,
    ),
    withCreditStatus(
      {
        id: "llm",
        name: "Listing writer (LLM)",
        status: config.llmProvider === "mock" ? "mock" : "configured",
        detail:
          config.llmProvider === "openai"
            ? `OpenAI-compatible · ${config.openaiModel} · ${config.openaiBaseUrl}`
            : config.llmProvider === "ollama"
              ? `Ollama Cloud · ${config.ollama.model} · ${config.ollama.baseUrl}`
              : config.llmProvider === "omniroute"
                ? `OmniRoute · ${config.omniroute.model ?? "OMNIROUTE_MODEL unset"} · ${config.omniroute.baseUrl ?? "OMNIROUTE_BASE_URL unset"}`
                : "Deterministic template writer.",
        envVars: [
          "LLM_PROVIDER",
          "OPENAI_API_KEY",
          "OPENAI_BASE_URL",
          "OPENAI_MODEL",
          "OLLAMA_API_KEY",
          "OLLAMA_MODEL",
          "OMNIROUTE_API_KEY",
          "OMNIROUTE_BASE_URL",
          "OMNIROUTE_MODEL",
        ],
      },
      opts?.providerCredits,
    ),
    {
      id: "auth",
      name: "Dashboard auth",
      status: config.usingDevPassword ? "missing" : "configured",
      detail: config.usingDevPassword ? "Using dev password. Set DASHBOARD_PASSWORD + AUTH_SECRET." : "Password protected",
      envVars: ["DASHBOARD_PASSWORD", "AUTH_SECRET", "CRON_SECRET"],
    },
  ];
}
