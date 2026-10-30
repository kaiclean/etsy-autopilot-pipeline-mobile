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
    summary: "Connect Printify to the same Etsy shop, then pin a blueprint, provider and variants for each product. Missing pins hold that product; blanks are never auto-selected.",
    envVars: ["PRINTIFY_API_TOKEN", "PRINTIFY_SHOP_ID"],
    optionalEnvVars: ["PRINTIFY_PRESETS_JSON", "PRINTIFY_PIN_PRESET", "PRINTIFY_BLUEPRINT_ID", "PRINTIFY_PRINT_PROVIDER_ID", "PRINTIFY_VARIANT_IDS", "PRINTIFY_WEBHOOK_SECRET"],
    bullets: [
      "Printify → My profile → Connections → generate a token → PRINTIFY_API_TOKEN.",
      "GET https://api.printify.com/v1/shops.json and copy the Etsy-connected shop id into PRINTIFY_SHOP_ID.",
      "Run npm run printify:catalog -- --preset mug for read-only discovery, then set PRINTIFY_PRESETS_JSON. The legacy triple applies only to PRINTIFY_PIN_PRESET (default posterA3).",
      "The maintenance cron registers one webhook per topic to POST /api/webhooks/printify with PRINTIFY_WEBHOOK_SECRET. The handler does not publish listings.",
      "In Etsy, add Printify as a production partner before live POD orders.",
    ],
  },
  {
    id: "llm",
    title: "LLM and image providers",
    href: "https://ollama.com",
    hrefLabel: "Ollama Cloud",
    summary:
      "Text and images use separate endpoints. Ollama Cloud can write listings, and it has no image API. A shared OPENAI_BASE_URL of https://ollama.com/v1 returns 404 on every image call.",
    envVars: [],
    optionalEnvVars: [
      "LLM_PROVIDER",
      "FREE_ONLY_MODE",
      "OLLAMA_LOCAL_BASE_URL",
      "OLLAMA_LOCAL_MODEL",
      "OLLAMA_LOCAL_VISION_MODEL",
      "CLOUDFLARE_WORKERS_PLAN",
      "IMAGE_PROVIDER",
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
      "OPENAI_MODEL",
      "OPENAI_IMAGE_MODEL",
      "IMAGE_BASE_URL",
      "IMAGE_API_KEY",
      "IMAGE_MODEL",
      "OLLAMA_API_KEY",
      "OLLAMA_MODEL",
      "OMNIROUTE_BASE_URL",
      "OMNIROUTE_API_KEY",
      "OMNIROUTE_MODEL",
      "OMNIROUTE_IMAGE_MODEL",
      "RUNPOD_API_KEY",
      "RUNPOD_ENDPOINT_ID",
      "RUNPOD_COMFY_WORKFLOW",
      "IMAGE_FALLBACK_PROVIDER",
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_IMAGE_MODEL",
      "REALESRGAN_MODEL_PATH",
      "REALESRGAN_MODEL_KEY",
      "REALESRGAN_MODEL_URL",
      "REALESRGAN_MODEL_SHA256",
    ],
    bullets: [
      "Free-only box setup: FREE_ONLY_MODE=true, LLM_PROVIDER=ollama-local, OLLAMA_LOCAL_MODEL set to an installed model, and optionally OLLAMA_LOCAL_VISION_MODEL for an installed vision model. OLLAMA_LOCAL_BASE_URL defaults to http://127.0.0.1:11434/v1 and must use localhost or a private IP. Verify text and image assessment on the box; invalid or unavailable vision still holds artwork for human review.",
      "For free-only image generation select Cloudflare and explicitly confirm CLOUDFLARE_WORKERS_PLAN=free after checking your account. This environment value is an operator declaration, not verification of Cloudflare billing. Paid providers and paid fallbacks are refused; quota errors stop work.",
      "Ollama Cloud: LLM_PROVIDER=ollama, OLLAMA_API_KEY, and a vision-capable OLLAMA_MODEL. The base is fixed at https://ollama.com/v1. Design sends images for visual assessment through /chat/completions; this is distinct from image generation.",
      "For image generation, set IMAGE_BASE_URL, IMAGE_API_KEY, and IMAGE_MODEL. Each one falls back to OPENAI_BASE_URL, OPENAI_API_KEY, and OPENAI_IMAGE_MODEL when it is empty.",
      "OmniRoute for both: LLM_PROVIDER=omniroute and IMAGE_PROVIDER=omniroute, plus OMNIROUTE_BASE_URL, OMNIROUTE_API_KEY, OMNIROUTE_MODEL, and OMNIROUTE_IMAGE_MODEL. Text POSTs /chat/completions. Images POST /images/generations and accept url or b64_json.",
      "OpenAI or OpenRouter still work with LLM_PROVIDER=openai and IMAGE_PROVIDER=openai. OpenRouter uses OPENAI_BASE_URL=https://openrouter.ai/api/v1.",
      "RunPod Serverless ComfyUI: set IMAGE_PROVIDER=runpod, RUNPOD_API_KEY, RUNPOD_ENDPOINT_ID, and RUNPOD_COMFY_WORKFLOW to the endpoint ID and ComfyUI API-format workflow JSON. Use {{PROMPT}} in the positive prompt node; {{SEED}}, {{WIDTH}}, and {{HEIGHT}} are optional placeholders. Print briefs use the worker's 4x-UltraSharp.pth model (override RUNPOD_UPSCALE_MODEL) before SaveImage; digital keeps native size. Use a vision-capable LLM_PROVIDER, optionally VISION_MODEL, for design assessment. Keep keys in deployment secrets.",
      "Cloudflare Workers AI: set IMAGE_PROVIDER=cloudflare, CLOUDFLARE_ACCOUNT_ID, and CLOUDFLARE_API_TOKEN (Workers AI Run permission). CLOUDFLARE_IMAGE_MODEL defaults to FLUX.1 schnell; FLUX.2 klein-4b is an opt-in native model capped at 1920×1920 and estimated at 1,000 neurons per image (10,000/day free allocation).",
      "Print-ready files pass through the shared Real-ESRGAN x4plus ONNX CPU upscaler when its BSD-3-Clause model is available. Load order is REALESRGAN_MODEL_PATH, then S3 REALESRGAN_MODEL_KEY, then an HTTPS REALESRGAN_MODEL_URL download (defaults to the pinned x4plus ONNX, SHA-256 verified, cached in tmp; set it to off to disable). Without ONNX, Lanczos fallback is held for apparel, posters, and large digital files; mug and standard digital may pass pixel gates.",
      "Optional IMAGE_FALLBACK_PROVIDER selects a real provider to try once if the primary fails; empty disables fallback. Configure that provider's credentials too. Both attempts count toward the estimated AI budget; no mock fallback is allowed.",
      "Connections → Test connection sends one tiny text request and one image request for OpenAI-compatible or Cloudflare image providers. For RunPod it runs the configured workflow, which may incur GPU charges. It tests the primary directly, without fallback. Keys are not shown.",
    ],
  },
  {
    id: "storage",
    title: "Image storage",
    href: "https://docs.railway.com/storage/buckets",
    hrefLabel: "Railway buckets",
    summary: "S3-compatible storage is preferred. Vercel Blob is the fallback. Neither one changes publish mode.",
    envVars: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_ENDPOINT_URL_S3", "S3_BUCKET"],
    optionalEnvVars: ["AWS_REGION", "S3_PUBLIC_BASE_URL", "S3_URL_MODE", "S3_FORCE_PATH_STYLE", "BLOB_READ_WRITE_TOKEN", "REALESRGAN_MODEL_KEY", "REALESRGAN_MODEL_PATH"],
    bullets: [
      "Set the AWS access key, secret, endpoint, and S3_BUCKET. Values are never shown here.",
      "With S3_PUBLIC_BASE_URL, that public origin is stored. Otherwise the app serves $APP_URL/api/media/<key>.",
      "Set BLOB_READ_WRITE_TOKEN only when S3 is not configured.",
    ],
  },
  {
    id: "push",
    title: "Web Push",
    href: "https://developer.mozilla.org/en-US/docs/Web/API/Push_API",
    hrefLabel: "Web Push API",
    summary: "In-app toasts work without these keys. Background push needs a VAPID key pair. Generate it locally and paste the names into the host.",
    envVars: ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"],
    optionalEnvVars: [],
    bullets: [
      "Run npm run vapid:generate. Put the public key, private key, and a mailto: subject in the environment.",
      "Settings → notifications subscribes the browser. The private key is never shown.",
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
      "Railway does not schedule jobs. GitHub Actions workflow autopilot-cron.yml calls /api/cron/<stage> after you set repository secrets CRON_SECRET (same as Railway) and optional AUTOPILOT_URL.",
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
      "That origin is used for the Etsy redirect URI, /api/media, and the Printify webhook callback.",
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
  if (step.id === "llm") {
    const keys = ["OPENAI_API_KEY", "OLLAMA_API_KEY", "OMNIROUTE_API_KEY", "RUNPOD_API_KEY"];
    if (keys.some((name) => presence[name]) || (presence.CLOUDFLARE_ACCOUNT_ID && presence.CLOUDFLARE_API_TOKEN)) return "ready";
    if (step.optionalEnvVars.some((name) => presence[name])) return "partial";
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
    "PRINTIFY_PRESETS_JSON=",
    "PRINTIFY_PIN_PRESET=posterA3",
    "PRINTIFY_BLUEPRINT_ID=",
    "PRINTIFY_PRINT_PROVIDER_ID=",
    "PRINTIFY_VARIANT_IDS=",
    "PRINTIFY_WEBHOOK_SECRET=",
    "VAPID_PUBLIC_KEY=",
    "VAPID_PRIVATE_KEY=",
    "VAPID_SUBJECT=",
    "AWS_ACCESS_KEY_ID=",
    "AWS_SECRET_ACCESS_KEY=",
    "AWS_ENDPOINT_URL_S3=",
    "AWS_REGION=",
    "S3_BUCKET=",
    "S3_PUBLIC_BASE_URL=",
    "BLOB_READ_WRITE_TOKEN=",
    "LLM_PROVIDER=mock",
    "IMAGE_PROVIDER=mock",
    "IMAGE_FALLBACK_PROVIDER=",
    "CLOUDFLARE_ACCOUNT_ID=",
    "CLOUDFLARE_API_TOKEN=",
    "OPENAI_API_KEY=",
    "OPENAI_BASE_URL=",
    "OPENAI_MODEL=",
    "OPENAI_IMAGE_MODEL=",
    "IMAGE_API_KEY=",
    "IMAGE_BASE_URL=",
    "IMAGE_MODEL=",
    "OLLAMA_API_KEY=",
    "OLLAMA_MODEL=",
    "OMNIROUTE_API_KEY=",
    "OMNIROUTE_BASE_URL=",
    "OMNIROUTE_MODEL=",
    "OMNIROUTE_IMAGE_MODEL=",
    "RUNPOD_API_KEY=",
    "RUNPOD_ENDPOINT_ID=",
    "RUNPOD_COMFY_WORKFLOW=",
    "RUNPOD_COST_PER_IMAGE_CHF=0.05",
    "PUBLISH_MODE=dry-run",
    "DEMO_MODE=",
  ].join("\n");
}
