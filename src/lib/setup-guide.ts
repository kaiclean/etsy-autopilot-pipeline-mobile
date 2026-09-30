export type SetupStepStatus = "ready" | "partial" | "missing";

export type SetupStep = {
  id: string;
  title: string;
  href: string;
  hrefLabel: string;
  summary: string;
  envVars: string[];
  optionalEnvVars: string[];
  bullets: string[];
};

const SET = (name: string) => {
  const value = process.env[name];
  return Boolean(value && value.trim() !== "");
};

/** Public origin for the OAuth callback. Userinfo and passwords in APP_URL are dropped. */
export function publicAppOrigin(): string | undefined {
  const raw = process.env.APP_URL?.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.username || url.password) {
      url.username = "";
      url.password = "";
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

export function etsyRedirectUri(): string {
  const origin = publicAppOrigin();
  return origin ? `${origin}/api/etsy/oauth/callback` : "/api/etsy/oauth/callback";
}

export const SETUP_STEPS: SetupStep[] = [
  {
    id: "neon",
    title: "Neon database",
    href: "https://console.neon.tech",
    hrefLabel: "Open Neon console",
    summary: "Live shop data needs Postgres. Without DATABASE_URL the app uses an embedded database on this machine.",
    envVars: ["DATABASE_URL"],
    optionalEnvVars: [],
    bullets: [
      "Create a project at Neon and copy the pooled connection string into DATABASE_URL.",
      "On Railway, add it under the service Variables. Do not commit the string.",
    ],
  },
  {
    id: "etsy",
    title: "Etsy shop",
    href: "https://www.etsy.com/developers/your-apps",
    hrefLabel: "Etsy developer apps",
    summary: "Create an app, set the four variables, then authorize the shop. Tokens are stored in the database and are never shown here.",
    envVars: ["ETSY_API_KEY", "ETSY_SHARED_SECRET", "ETSY_SHOP_ID", "ETSY_REDIRECT_URI"],
    optionalEnvVars: ["ETSY_TAXONOMY_ID_DIGITAL", "ETSY_TAXONOMY_ID_POSTER"],
    bullets: [
      "Keystring → ETSY_API_KEY. Shared secret → ETSY_SHARED_SECRET.",
      "Register the redirect URI so it matches ETSY_REDIRECT_URI exactly, then use Connect Etsy shop.",
      "Shop id is the numeric id from Shop Manager or from GET /v3/application/users/{user_id}/shops after OAuth.",
    ],
  },
  {
    id: "printify",
    title: "Printify",
    href: "https://developers.printify.com/",
    hrefLabel: "Printify API docs",
    summary: "Connect Printify to the same Etsy shop, then add a personal access token. Blueprint and variant ids are optional; the catalog picker fills them in when they are empty.",
    envVars: ["PRINTIFY_API_TOKEN", "PRINTIFY_SHOP_ID"],
    optionalEnvVars: ["PRINTIFY_BLUEPRINT_ID", "PRINTIFY_PRINT_PROVIDER_ID", "PRINTIFY_VARIANT_IDS"],
    bullets: [
      "Printify → My profile → Connections → generate a token → PRINTIFY_API_TOKEN.",
      "GET https://api.printify.com/v1/shops.json and copy the Etsy-connected shop id into PRINTIFY_SHOP_ID.",
      "In Etsy, add Printify as a production partner before live POD orders.",
    ],
  },
  {
    id: "llm",
    title: "LLM and image providers",
    href: "https://openrouter.ai/keys",
    hrefLabel: "OpenRouter keys",
    summary: "Listing copy and art stay on mock providers until you point OPENAI_* at OpenAI or OpenRouter. The key itself is never shown.",
    envVars: ["OPENAI_API_KEY"],
    optionalEnvVars: ["LLM_PROVIDER", "IMAGE_PROVIDER", "OPENAI_BASE_URL", "OPENAI_MODEL", "OPENAI_IMAGE_MODEL"],
    bullets: [
      "OpenAI keys: https://platform.openai.com/api-keys. OpenRouter keys: https://openrouter.ai/keys.",
      "Set LLM_PROVIDER=openai and IMAGE_PROVIDER=openai, plus OPENAI_API_KEY.",
      "For OpenRouter set OPENAI_BASE_URL=https://openrouter.ai/api/v1. Model names go in OPENAI_MODEL and OPENAI_IMAGE_MODEL.",
    ],
  },
  {
    id: "auth",
    title: "Dashboard auth and cron",
    href: "https://docs.railway.com/variables",
    hrefLabel: "Railway variables",
    summary: "Production sign-in needs a password and a signing secret. Cron calls need a bearer secret. Values stay in the host environment.",
    envVars: ["DASHBOARD_PASSWORD", "AUTH_SECRET", "CRON_SECRET"],
    optionalEnvVars: [],
    bullets: [
      "Generate AUTH_SECRET and CRON_SECRET with openssl rand -base64 32. Do not reuse the dashboard password.",
      "Set DASHBOARD_PASSWORD to the phrase you type on the sign-in screen.",
      "Railway or any cron caller sends Authorization: Bearer <CRON_SECRET> to /api/cron/<stage>.",
    ],
  },
  {
    id: "app",
    title: "Public app URL",
    href: "https://docs.railway.com/networking/public-networking",
    hrefLabel: "Railway public networking",
    summary: "APP_URL is the public origin Etsy and Printify use for image files and the OAuth callback. It is not a secret, but this page only shows the origin.",
    envVars: ["APP_URL"],
    optionalEnvVars: [],
    bullets: [
      "Set APP_URL to the https origin of this deployment, with no path and no credentials.",
      "Use that origin in the Etsy redirect URI.",
    ],
  },
];

const PRESENCE_NAMES = [...new Set(SETUP_STEPS.flatMap((step) => [...step.envVars, ...step.optionalEnvVars]))];

/** Which setup variables are non-empty. Values are never returned. */
export function setupPresence(): Record<string, boolean> {
  return Object.fromEntries(PRESENCE_NAMES.map((name) => [name, SET(name)]));
}

export function stepStatus(step: SetupStep, presence: Record<string, boolean>, etsyConnected = false): SetupStepStatus {
  const required = step.envVars.filter((name) => presence[name]);
  if (step.id === "etsy") {
    if (required.length === step.envVars.length && etsyConnected) return "ready";
    if (required.length > 0 || etsyConnected) return "partial";
    return "missing";
  }
  if (required.length === step.envVars.length) return "ready";
  if (required.length > 0) return "partial";
  return "missing";
}

/** Names and safe defaults only. PUBLISH_MODE stays dry-run in the pasted list. */
export function setupChecklist(): string {
  return [
    "# Paste values in Railway → Variables or .env.local. Do not commit this file.",
    "DATABASE_URL=",
    "APP_URL=",
    "DASHBOARD_PASSWORD=",
    "AUTH_SECRET=",
    "CRON_SECRET=",
    "ETSY_API_KEY=",
    "ETSY_SHARED_SECRET=",
    "ETSY_SHOP_ID=",
    "ETSY_REDIRECT_URI=",
    "PRINTIFY_API_TOKEN=",
    "PRINTIFY_SHOP_ID=",
    "PRINTIFY_BLUEPRINT_ID=",
    "PRINTIFY_PRINT_PROVIDER_ID=",
    "PRINTIFY_VARIANT_IDS=",
    "LLM_PROVIDER=mock",
    "IMAGE_PROVIDER=mock",
    "OPENAI_API_KEY=",
    "OPENAI_BASE_URL=",
    "OPENAI_MODEL=",
    "OPENAI_IMAGE_MODEL=",
    "PUBLISH_MODE=dry-run",
    "DEMO_MODE=",
  ].join("\n");
}
