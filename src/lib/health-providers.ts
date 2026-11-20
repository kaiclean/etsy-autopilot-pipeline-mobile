import { config } from "./config";
import { imageProviderStatusLabel, lastImageProviderError, type ImageRunFact, type ProviderCreditSignal } from "./provider-errors";
import { assertImageProviderAllowed, assertPaidInferenceAllowed, freeOnlyMode, localOllamaConfig } from "./free-mode";
import type { HealthCheck } from "./health";

export function explicit(name: string) {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
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

export function llmCheck(signal: ProviderCreditSignal): HealthCheck {
  return overlayCredits(llmProviderCheck(), signal, "llm");
}

export function imageCheck(signal: ProviderCreditSignal): HealthCheck {
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
  const localEnv = ["LLM_PROVIDER", "FREE_ONLY_MODE", "OLLAMA_LOCAL_BASE_URL", "OLLAMA_LOCAL_MODEL", "OLLAMA_LOCAL_VISION_MODEL"];
  if (requested === "ollama-local") {
    try {
      const local = localOllamaConfig();
      return { id: "llm", name: "LLM provider", level: "green", label: "Local configured",
        detail: `Local Ollama · ${local.model} · vision ${local.visionModel}. Verify model availability from the box. No API usage charge.`, envVars: localEnv };
    } catch (error) {
      return { id: "llm", name: "LLM provider", level: "red", label: "Incomplete",
        detail: error instanceof Error ? error.message : "Local Ollama configuration invalid", envVars: localEnv };
    }
  }
  try {
    if (freeOnlyMode() && requested && requested !== "mock") assertPaidInferenceAllowed(requested);
  } catch (error) {
    return { id: "llm", name: "LLM provider", level: "red", label: "Policy blocked",
      detail: error instanceof Error ? error.message : "Free-only policy invalid", envVars: [...envVars, "FREE_ONLY_MODE"] };
  }
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
    "IMAGE_FALLBACK_PROVIDER",
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_API_TOKEN",
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
    "RUNPOD_API_KEY",
    "RUNPOD_ENDPOINT_ID",
    "RUNPOD_COMFY_WORKFLOW",
  ];
  const provider = config.imageProvider;
  try {
    assertImageProviderAllowed(provider, provider === "mock");
    if (config.imageFallbackProvider) assertImageProviderAllowed(config.imageFallbackProvider);
  } catch (error) {
    return { id: "images", name: "Image provider", level: "red", label: "Policy blocked",
      detail: error instanceof Error ? error.message : "Free-only policy invalid", envVars: [...envVars, "FREE_ONLY_MODE", "CLOUDFLARE_WORKERS_PLAN"] };
  }
  if (provider === "cloudflare") {
    const ready = Boolean(config.cloudflare.accountId && config.cloudflare.apiToken);
    return {
      id: "images",
      name: "Image provider",
      level: ready ? "green" : "red",
      label: ready ? "Ready" : "Incomplete",
      detail: ready
        ? "Cloudflare Workers AI · FLUX.1 schnell · free allocation subject to Cloudflare quotas."
        : "Cloudflare needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN. Secret values are hidden.",
      envVars,
    };
  }
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
    return {
      id: "images",
      name: "Image provider",
      level: "green",
      label: "Ready",
      detail: `OpenAI-compatible · ${config.imageModel} · ${config.imageBaseUrl}`,
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
    const ready = Boolean(base && model);
    return {
      id: "images",
      name: "Image provider",
      level: ready ? "green" : "yellow",
      label: ready ? "Ready" : "Incomplete",
      detail: `OmniRoute · ${model ?? "OMNIROUTE_IMAGE_MODEL unset"} · ${base ?? "OMNIROUTE_BASE_URL unset"}`,
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
  if (provider === "runpod") {
    const runpod = config.runpod;
    if (!runpod.apiKey || !runpod.endpointId || !runpod.workflow) {
      return {
        id: "images",
        name: "Image provider",
        level: "red",
        label: "Incomplete",
        detail: "RunPod needs RUNPOD_API_KEY, RUNPOD_ENDPOINT_ID, and RUNPOD_COMFY_WORKFLOW. Secret values are hidden.",
        envVars,
      };
    }
    return {
      id: "images",
      name: "Image provider",
      level: "green",
      label: "Ready",
      detail: `RunPod Serverless · endpoint ${runpod.endpointId}. API key and workflow are hidden.`,
      envVars,
    };
  }
  return {
    id: "images",
    name: "Image provider",
    level: "yellow",
    label: "Mock",
    detail: "Mock placeholder art. Set IMAGE_PROVIDER to higgsfield, openai, replicate, omniroute, or runpod. IMAGE_BASE_URL falls back to OPENAI_BASE_URL.",
    envVars,
  };
}

export function overlayImageRun(check: HealthCheck, run: ImageRunFact | null | undefined): HealthCheck {
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
