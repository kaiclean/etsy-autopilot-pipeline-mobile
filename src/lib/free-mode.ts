/** An opt-in policy for inference calls, not proof of a cloud account's billing plan. */
export function freeOnlyMode() {
  const value = process.env.FREE_ONLY_MODE?.trim();
  if (!value || value === "false") return false;
  if (value === "true") return true;
  throw new Error("FREE_ONLY_MODE must be true or false");
}

export function assertPaidInferenceAllowed(provider: string) {
  if (freeOnlyMode()) throw new Error(`FREE_ONLY_MODE blocks paid inference provider ${provider}`);
}

export function localOllamaConfig() {
  const baseUrl = validateLocalOllamaUrl(process.env.OLLAMA_LOCAL_BASE_URL?.trim() || "http://127.0.0.1:11434/v1");
  const model = process.env.OLLAMA_LOCAL_MODEL?.trim();
  if (!model) throw new Error("OLLAMA_LOCAL_MODEL missing; install and select a local model before running the box worker");
  const visionModel = process.env.OLLAMA_LOCAL_VISION_MODEL?.trim() || model;
  for (const name of [model, visionModel]) assertLocalOllamaModel(name);
  return { baseUrl, model, visionModel };
}

export function assertLocalOllamaModel(name: string) {
  // Local Ollama can transparently forward :cloud/-cloud models to its paid cloud service.
  if (!name || /cloud/i.test(name) || /\s|:\/\//.test(name)) {
    throw new Error("Ollama local models must be installed locally; cloud model tags and remote model URLs are refused");
  }
}

/** Literal private addresses avoid accepting a public paid endpoint disguised as a local provider. */
export function validateLocalOllamaUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("OLLAMA_LOCAL_BASE_URL must be a local HTTP(S) /v1 URL"); }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const ipv4 = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host.split(".").map(Number) : null;
  const privateV4 = ipv4 && (ipv4[0] === 127 || ipv4[0] === 10 ||
    (ipv4[0] === 192 && ipv4[1] === 168) || (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31));
  // URL already validates and canonicalizes bracketed IPv6 literals.
  const privateV6 = host.includes(":") && (host === "::1" || /^(fc|fd)/.test(host));
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      !["/v1", "/v1/"].includes(url.pathname) || !(host === "localhost" || privateV4 || privateV6)) {
    throw new Error("OLLAMA_LOCAL_BASE_URL must target localhost or a private IP at /v1; public/cloud endpoints are refused");
  }
  return url.toString().replace(/\/$/, "");
}

export function assertChatInferenceAllowed(provider: string, baseUrl?: string) {
  if (provider === "ollama-local") {
    validateLocalOllamaUrl(baseUrl || "");
    return;
  }
  assertPaidInferenceAllowed(provider);
}

export function assertImageProviderAllowed(provider: string, demo = false) {
  if (!freeOnlyMode()) return;
  if (provider === "mock" && demo) return;
  if (provider !== "cloudflare") throw new Error(`FREE_ONLY_MODE blocks image provider ${provider}, including paid fallbacks`);
  if (process.env.CLOUDFLARE_WORKERS_PLAN?.trim() !== "free") {
    throw new Error("FREE_ONLY_MODE requires CLOUDFLARE_WORKERS_PLAN=free; confirm Workers Free in the Cloudflare account before enabling generation");
  }
}

const FREE_IMAGE_MODELS = new Set([
  "@cf/black-forest-labs/flux-1-schnell",
  "@cf/black-forest-labs/flux-2-klein-4b",
]);

export function assertCloudflareImageModelAllowed(model: string) {
  assertImageProviderAllowed("cloudflare");
  if (freeOnlyMode() && !FREE_IMAGE_MODELS.has(model)) {
    throw new Error("FREE_ONLY_MODE requires a reviewed Workers Free image model; arbitrary model substitutions are refused");
  }
}
