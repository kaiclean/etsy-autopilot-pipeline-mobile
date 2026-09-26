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
  get openaiModel() {
    return env("OPENAI_MODEL") ?? "gpt-4.1-mini";
  },
  get replicateToken() {
    return env("REPLICATE_API_TOKEN");
  },
  get imageProvider(): "mock" | "higgsfield" | "openai" | "replicate" {
    const p = env("IMAGE_PROVIDER");
    if (p === "higgsfield" || p === "openai" || p === "replicate") return p;
    return "mock";
  },
  get llmProvider(): "mock" | "openai" {
    return env("LLM_PROVIDER") === "openai" && env("OPENAI_API_KEY") ? "openai" : "mock";
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

export function hasEtsyCredentials() {
  const e = config.etsy;
  return Boolean(e.apiKey && e.sharedSecret && e.shopId);
}

export function hasPrintifyCredentials() {
  const p = config.printify;
  return Boolean(p.token && p.shopId);
}

/** Demo mode = seeded demo rows visible + mock adapters. Switches off once Etsy creds exist. */
export function isDemoMode() {
  if (env("DEMO_MODE") === "true") return true;
  if (env("DEMO_MODE") === "false") return false;
  return !hasEtsyCredentials();
}

export type IntegrationStatus = {
  id: string;
  name: string;
  status: "connected" | "configured" | "mock" | "missing";
  detail: string;
  envVars: string[];
};

export function integrationStatus(etsyConnected: boolean): IntegrationStatus[] {
  const e = config.etsy;
  const p = config.printify;
  const h = config.higgsfield;
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
      detail: hasPrintifyCredentials()
        ? `Shop ${p.shopId}${p.blueprintId ? ` · blueprint ${p.blueprintId}` : " · set PRINTIFY_BLUEPRINT_ID"}`
        : "Dry-run adapter.",
      envVars: ["PRINTIFY_API_TOKEN", "PRINTIFY_SHOP_ID", "PRINTIFY_BLUEPRINT_ID"],
    },
    {
      id: "images",
      name: "Image generation",
      status: config.imageProvider === "mock" ? "mock" : "configured",
      detail:
        config.imageProvider === "mock"
          ? "Mock placeholder art. Set IMAGE_PROVIDER=higgsfield|openai|replicate."
          : `Provider: ${config.imageProvider}${config.imageProvider === "higgsfield" && !h.apiKey ? " (missing key)" : ""}`,
      envVars: ["IMAGE_PROVIDER", "HIGGSFIELD_API_KEY", "HIGGSFIELD_API_SECRET", "REPLICATE_API_TOKEN"],
    },
    {
      id: "llm",
      name: "Listing writer (LLM)",
      status: config.llmProvider === "openai" ? "configured" : "mock",
      detail: config.llmProvider === "openai" ? `OpenAI · ${config.openaiModel}` : "Deterministic template writer.",
      envVars: ["LLM_PROVIDER", "OPENAI_API_KEY", "OPENAI_MODEL"],
    },
    {
      id: "auth",
      name: "Dashboard auth",
      status: config.usingDevPassword ? "missing" : "configured",
      detail: config.usingDevPassword ? "Using dev password. Set DASHBOARD_PASSWORD + AUTH_SECRET." : "Password protected",
      envVars: ["DASHBOARD_PASSWORD", "AUTH_SECRET", "CRON_SECRET"],
    },
  ];
}
